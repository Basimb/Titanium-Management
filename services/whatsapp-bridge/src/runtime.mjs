import { resolvePhone, selectIncoming } from './identity.mjs';
import { deliverOne } from './delivery.mjs';
import { inspectGroupMembership, boundedPlainText, groupJid, withAbortSignal } from './group-privacy.mjs';
import { processControlJob } from './control.mjs';
import { selectVoiceIncoming, MAX_VOICE_SECONDS } from './voice.mjs';
import { createPollChoices } from './polls.mjs';
import { createPrivateOutboxTransport } from './private-transport.mjs';

function withDeadline(work) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('metadata_timeout')), 10_000);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

// Dependency injection allows lifecycle tests without initializing a real socket.
export function createBridgeRuntime({ config, store, auth, makeWASocket, jidNormalizedUser,
  makeCacheableSignalKeyStore, DisconnectReason, logger, onStop = () => {}, output = console,
  now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, fetcher = fetch, otpQueue,
  control, isActiveNumber = () => false, secretaryJobs, secretaryOutbox, agentFollowups, transcribeVoice,
  proto, generateWAMessageContent, generateWAMessage, decryptPollVote, normalizeMessageContent }) {
  let socket;
  let ready = false;
  let stopped = false;
  let restarting = false;
  let reconnectCount = 0;
  let activatedAt = Infinity;
  let draining = false;
  let incomingChain = Promise.resolve();
  let reconnectTimer;
  let pairRequested = false;
  let preferBackground = false;
  let preferOutbox = true;
  const groupCache = new Map();
  const groupEpoch = new Map();
  const polls = proto && generateWAMessageContent && decryptPollVote
    ? createPollChoices({ store, config, proto, generateWAMessageContent, decryptPollVote, normalizeMessageContent, now }) : null;
  const privateTransport = secretaryOutbox && proto && generateWAMessage
    ? createPrivateOutboxTransport({ store, config, proto, generateWAMessage, normalizeJid: jidNormalizedUser,
      authorize: isActiveNumber, recordUpdate: update => secretaryOutbox.recordTransportUpdate(update), now }) : null;

  function invalidateGroup(jid) {
    if (!config.allowedGroups.has(jid) && !groupEpoch.has(jid)) return;
    groupCache.delete(jid);
    groupEpoch.set(jid, (groupEpoch.get(jid) || 0) + 1);
  }

  async function inspectGroup(jid, mustBeAllowlisted = true) {
    const unavailable = { allowed: false, reason: 'membership_unavailable', memberCount: 0 };
    const current = socket;
    const epoch = groupEpoch.get(jid) || 0;
    if (!groupJid(jid) || !ready || stopped || (mustBeAllowlisted && !config.allowedGroups.has(jid))) return unavailable;
    groupEpoch.set(jid, epoch);
    try {
      // ALWAYS ask WhatsApp now. cachedGroupMetadata is for this one send's encryption,
      // never an authorization decision and never retained for five minutes.
      const metadata = await withDeadline(() => current.groupMetadata(jid));
      const result = await inspectGroupMembership(metadata, jid, config, {
        normalizeJid: jidNormalizedUser,
        lookupPhoneForLid: lid => current.signalRepository.lidMapping.getPNForLID(lid),
      }, isActiveNumber);
      if (current !== socket || stopped || !ready || epoch !== (groupEpoch.get(jid) || 0)) return unavailable;
      if (result.allowed && mustBeAllowlisted) groupCache.set(jid, { metadata, expires: now() + 10_000 });
      return result;
    } catch { return unavailable; }
    finally { if (!config.allowedGroups.has(jid)) groupEpoch.delete(jid); }
  }

  async function sendGroup(jid, text, messageId, signal) {
    if (signal?.aborted) throw new Error('group_send_cancelled');
    const check = await inspectGroup(jid);
    if (!check.allowed || signal?.aborted) throw new Error('group_privacy_blocked');
    try { await socket.sendMessage(jid, { text: boundedPlainText(text), linkPreview: null }, { messageId }); }
    finally { groupCache.delete(jid); }
  }

  async function privacyRefusal(body) {
    if (!body.groupId || !ready || stopped || !config.allowedNumbers.has(body.senderNumber) ||
      !await isActiveNumber(body.senderNumber) || !control?.reservePrivacyAlert(body.groupId, body.senderNumber)) return;
    // Only a generic private refusal to the authenticated sender. No group names,
    // roster, task text, manager report or other employee data escapes the group.
    await socket.sendMessage(`${body.senderNumber}@s.whatsapp.net`, {
      text: 'ما قدرت أعالج طلب الجروب بأمان لأن التحقق من صلاحيات جميع أعضائه غير مكتمل. ابعت طلبك هون على الخاص أو راجع باسم.', linkPreview: null,
    });
  }

  const voiceReplyAt = new Map();
  // Private-chat only, authorized senders only, one notice per minute per sender.
  // Tells the person the voice note was not processed instead of silently dropping it.
  async function voiceRejectionReply(message, event, identity) {
    try {
      const remote = message?.key?.remoteJid;
      if (!remote || message?.key?.fromMe || remote.endsWith('@g.us') || !ready || stopped) return;
      const resolved = await selectIncoming({ ...message, message: { conversation: 'رسالة صوتية' } }, event, config, identity, now(), activatedAt);
      const number = resolved?.body.senderNumber;
      if (!number || !await isActiveNumber(number)) return;
      const last = voiceReplyAt.get(number) || 0;
      if (now() - last < 60_000) return;
      voiceReplyAt.set(number, now());
      const seconds = Number(message?.message?.audioMessage?.seconds) || 0;
      const text = seconds > MAX_VOICE_SECONDS
        ? `ما قدرت أسمع الرسالة الصوتية لأنها أطول من ${Math.round(MAX_VOICE_SECONDS / 60)} دقائق. سجّلها أقصر أو اكتبها لي.`
        : 'ما قدرت أسمع الرسالة الصوتية. جرّب تسجّلها مرة ثانية أو اكتبها لي.';
      await socket.sendMessage(remote, { text, linkPreview: null });
    } catch { /* never let a courtesy reply break intake */ }
  }

  function stop(code) {
    if (stopped) return;
    stopped = true;
    ready = false;
    timers.clearTimeout(reconnectTimer);
    timers.clearInterval(queueTimer);
    output.error(`Titanium bridge stopped: ${code}. No account was logged out or deleted.`);
    socket?.end(new Error('bridge_stopped'));
    // Do not close SQLite while an in-flight delivery can still commit its result.
    onStop(code);
  }

  async function startSocket() {
    if (stopped) return;
    ready = false;
    restarting = false;
    const current = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger, markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async key => privateTransport?.isTracked(key?.id)
        ? privateTransport.getMessage(key, { socket: current, isCurrent: () => ready && !stopped && current === socket })
        : polls?.outgoingMessage(key) || store.outgoingMessage(key),
      cachedGroupMetadata: async jid => {
        const cached = groupCache.get(jid);
        return cached && cached.expires > now() ? cached.metadata : undefined;
      },
      connectTimeoutMs: 30_000,
    });
    socket = current;
    privateTransport?.attach(current, () => ready && !stopped && current === socket);
    let connectionEpoch = 0;
    const identity = {
      normalizeJid: jidNormalizedUser,
      lookupPhoneForLid: jid => current.signalRepository.lidMapping.getPNForLID(jid),
    };
    current.ev.on('groups.update', updates => {
      for (const update of updates) if (update.id) invalidateGroup(update.id);
    });
    current.ev.on('group-participants.update', update => invalidateGroup(update.id));
    current.ev.on('creds.update', update => {
      if (stopped || current !== socket) return;
      auth.saveCreds(update).catch(() => stop('auth_persistence_failed'));
    });
    current.ev.on('connection.update', update => {
      void (async () => {
        if (stopped || current !== socket) return;
        const epoch = update.connection ? ++connectionEpoch : connectionEpoch;
        if (update.isNewLogin === true) {
          output.info('Titanium bridge pairing accepted; awaiting connection restart.');
        }
        if (update.qr && !auth.state.creds.registered && !pairRequested) {
          if (!config.allowPairing) { stop('pairing_required'); return; }
          pairRequested = true;
          const code = await current.requestPairingCode(config.botNumber);
          output.info(`Titanium linked-device pairing code: ${code}`);
        }
        if (update.connection === 'open') {
          const self = await resolvePhone(current.user?.id || auth.state.creds.me?.id,
            auth.state.creds.me?.id, identity);
          if (stopped || current !== socket || epoch !== connectionEpoch) return;
          if (self !== config.botNumber) { stop('unexpected_or_unresolved_account'); return; }
          store.bindAccount(self);
          activatedAt = store.activate(now());
          ready = true;
          reconnectCount = 0;
          output.info('Titanium bridge connected to the configured account; only allowlisted fresh messages are eligible.');
        }
        if (update.connection === 'close') {
          ready = false;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          const safeStatus = Number.isSafeInteger(code) ? code : 'unknown';
          output.info(`Titanium bridge connection closed: status=${safeStatus}; registered=${auth.state.creds.registered === true}.`);
          if ([DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.connectionReplaced,
            DisconnectReason.badSession, DisconnectReason.multideviceMismatch].includes(code)) {
            stop('session_requires_owner_attention'); return;
          }
          if (restarting) return;
          restarting = true;
          reconnectCount += 1;
          if (reconnectCount > 10) { stop('reconnect_limit_reached'); return; }
          const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60_000, 2000 * 2 ** (reconnectCount - 1));
          reconnectTimer = timers.setTimeout(() => startSocket().catch(() => stop('socket_start_failed')), delay);
        }
      })().catch(() => stop('connection_handler_failed'));
    });
    current.ev.on('messages.upsert', event => {
      if (!ready || stopped || current !== socket || config.tasksEnabled === false) return;
      incomingChain = incomingChain.then(async () => {
        for (const message of event.messages) {
          if (!ready || stopped || current !== socket) break;
          if (polls?.isPollVote(message)) {
            await polls.acceptVote(message, event, { identity, activatedAt,
              authorize: async sender => ready && !stopped && current === socket && config.tasksEnabled !== false
                && await isActiveNumber(sender) && ready && !stopped && current === socket });
            continue;
          }
          let incoming = await selectIncoming(message, event, config, identity, now(), activatedAt);
          if (!incoming && transcribeVoice && config.voiceEnabled && message.message?.audioMessage) {
            try {
              incoming = await selectVoiceIncoming(message,event,config,identity,now(),activatedAt,{
                transcribe: transcribeVoice, reserve: body => control?.reserveVoice(body) === true,
                authorize: async body => ready && !stopped && current === socket && await isActiveNumber(body.senderNumber)
                  && (body.groupId === null || (await inspectGroup(body.groupId)).allowed),
              });
            } catch (error) {
              const code = /^(?:voice_[a-z_]+|AbortError|TimeoutError)$/.test(error?.message || '') ? error.message : 'unavailable_or_rejected';
              output.info(`Titanium voice: ${code}. No audio or transcript logged.`);
            }
            if (!incoming) await voiceRejectionReply(message, event, identity);
          }
          if (incoming && await isActiveNumber(incoming.body.senderNumber) && ready && !stopped && current === socket) store.enqueue(incoming);
        }
      }).catch(() => stop('incoming_persistence_failed'));
    });
  }

  async function sendScheduled({ to, text, messageId, signal }, privateOnly = false) {
    const current = socket;
    if (!ready || stopped || !signal || signal.aborted || typeof messageId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(messageId)) throw new Error('secretary_delivery_unavailable');
    const reply = boundedPlainText(text);
    if (!reply || (privateOnly && reply !== text)) throw new Error('invalid_secretary_reply');
    // An approved private batch can never be redirected to a group, newsletter,
    // LID, or a model-provided destination. Keep its previewed text unchanged.
    if (privateOnly && (typeof to !== 'string' || !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(to))) {
      throw new Error('secretary_private_destination_required');
    }
    if (privateOnly) {
      if (!privateTransport || typeof secretaryOutbox.recordTransportUpdate !== 'function') {
        throw Object.assign(new Error('transport_preflight_rejected'), { code: 'transport_preflight_rejected', definitelyNotSent: true });
      }
      return privateTransport.send({ to, text: reply, messageId, signal }, {
        socket: current, isCurrent: () => ready && !stopped && current === socket,
      });
    }
    if (groupJid(to)) { await withAbortSignal(() => sendGroup(to, reply, messageId, signal), signal); return; }
    const number = typeof to === 'string' ? to.replace(/@s\.whatsapp\.net$/, '') : '';
    if (!/^[1-9]\d{7,14}$/.test(number) || number === config.botNumber || !config.allowedNumbers.has(number)) {
      throw new Error('secretary_recipient_unavailable');
    }
    await withAbortSignal(async () => {
      const active = await isActiveNumber(number);
      if (!active || !ready || stopped || current !== socket || signal.aborted ||
        number === config.botNumber || !config.allowedNumbers.has(number)) throw new Error('secretary_recipient_unavailable');
      return current.sendMessage(`${number}@s.whatsapp.net`, { text: reply, linkPreview: null }, { messageId });
    }, signal);
  }

  async function drainBackground() {
    const jobs = preferOutbox ? ['outbox', 'reminder', 'followup'] : ['reminder', 'outbox', 'followup'];
    for (const kind of jobs) {
      if (!ready || stopped) return false;
      const queue = kind === 'outbox' ? secretaryOutbox : kind === 'followup' ? agentFollowups : secretaryJobs;
      if (!queue) continue;
      let result;
      try { result = await queue.deliverNext(message => sendScheduled(message, kind === 'outbox')); }
      catch (error) {
        if (kind === 'reminder') throw error;
        // A broadcast worker failure must not tear down the linked account or OTP.
        result = { status: 'failed' };
      }
      if (result.status !== 'idle') {
        preferOutbox = kind !== 'outbox';
        const label = kind === 'outbox' ? 'outbox' : kind === 'followup' ? 'followup' : 'delivery';
        const status = result.status === 'sent' ? 'sent' : result.status === 'submitted' ? 'submitted' : result.status === 'uncertain' ? 'uncertain' : 'failed';
        output.info(`Titanium secretary ${label}: ${status}.`);
        return true;
      }
    }
    return false;
  }

  async function drainInbox() {
    if (!ready || stopped) return false;
    const row = store.next(now());
    if (!row) return false;
    await deliverOne(store, row, config, {
      now, fetcher,
      authorizeChat: async body => await isActiveNumber(body.senderNumber) &&
        (body.groupId === null || (await inspectGroup(body.groupId)).allowed),
      onPrivacyBlocked: privacyRefusal,
      sendReply: async (jid, text, messageId, body, result) => {
        if (!ready || stopped) throw new Error('not_connected');
        if (!await isActiveNumber(body.senderNumber)) throw new Error('sender_disabled');
        if (config.allowedGroups.has(jid)) {
          await sendGroup(jid, text, messageId);
          return;
        }
        const current = socket;
        await current.sendMessage(jid, { text, linkPreview: null }, { messageId });
        if (polls && body.groupId === null && result?.choices) {
          // The text is the durable fallback. A poll failure must not retry this
          // successful text or interrupt login/inbox processing.
          try {
            const pollResult = await polls.sendQuestion({ choices: result.choices, chatJid: jid, senderNumber: body.senderNumber }, {
              identity: { normalizeJid: jidNormalizedUser, lookupPhoneForLid: value => current.signalRepository.lidMapping.getPNForLID(value) },
              creatorJids: [current.user?.id || auth.state.creds.me?.id, auth.state.creds.me?.lid].filter(Boolean),
              authorize: async sender => ready && !stopped && current === socket && config.tasksEnabled !== false
                && await isActiveNumber(sender) && ready && !stopped && current === socket,
              relay: (to, content, options, signal) => {
                if (signal.aborted || !ready || stopped || current !== socket) throw new Error('poll_unavailable');
                return current.relayMessage(to, content, options);
              },
            });
            if (pollResult.status === 'uncertain') output.info('Titanium choices: uncertain; text fallback retained.');
          } catch { output.info('Titanium choices: unavailable; text fallback retained.'); }
        }
      },
    });
    return true;
  }

  const queueTimer = timers.setInterval(() => {
    if (!ready || stopped || draining) return;
    draining = true;
    void (async () => {
      if (otpQueue) {
        const result = await otpQueue.deliverNext(async ({ to, code, challengeId, expiresAt, signal }) => {
          if (!ready || stopped || signal.aborted || now() >= expiresAt ||
            !/^[1-9]\d{7,14}$/.test(to) || !config.allowedNumbers.has(to) || !/^\d{6}$/.test(code)) {
            throw new Error('login_delivery_unavailable');
          }
          // Phone-bound private delivery only. OTP content never enters Groq or the chat inbox.
          await socket.sendMessage(`${to}@s.whatsapp.net`, {
            text: `رمز دخولك إلى إدارة تيتانيوم: ${code}\nصالح لمدة 5 دقائق ولمرة واحدة. لا تشاركه مع أي شخص.\nإذا لم تطلب الدخول، تجاهل الرسالة.`, linkPreview: null,
          }, { messageId: `TITANIUMOTP${challengeId.slice(0, 20).toUpperCase()}` });
        });
        if (result.status !== 'idle') {
          output.info(`Titanium login delivery: ${result.status === 'sent' ? 'sent' : 'failed'}.`);
          return;
        }
      }
      if (control && await processControlJob({ control,
        socket: { groupFetchAllParticipating: () => withDeadline(() => socket.groupFetchAllParticipating()) },
        config, inspectGroup, sendGroup, now })) return;
      if (config.tasksEnabled === false) return;
      // OTP is checked first on every tick. Alternate one inbox item with one
      // background delivery so either backlog can make progress without a bulk loop.
      if (preferBackground) {
        if (await drainBackground()) { preferBackground = false; return; }
        if (await drainInbox()) preferBackground = true;
      } else {
        if (await drainInbox()) { preferBackground = true; return; }
        if (await drainBackground()) preferBackground = false;
      }
    })().catch(() => stop('queue_failed')).finally(() => { draining = false; });
  }, 1000);
  return { start: startSocket, stop, status: () => ({ ready, stopped, reconnectCount }) };
}

