import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolvePhone } from './identity.mjs';
import { boundedPlainText, withAbortSignal } from './group-privacy.mjs';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const privateJid = value => typeof value === 'string' && /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(value);
const digest = value => createHash('sha256').update(value).digest();
const cleanLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 100
  && value === value.trim() && value === boundedPlainText(value) && !/[\r\n\t]/u.test(value);

// Invalid/unsupported questions retain the ordinary text reply, never a partial poll.
export function normalizePollChoices(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !identifier(value.id)
    || !cleanLabel(value.title) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
    || value.expiresAt > now + 60 * 60_000 || !Array.isArray(value.options)
    || value.options.length < 2 || value.options.length > 12) return null;
  if (value.options.some(option => !option || !identifier(option.id) || !cleanLabel(option.label))) return null;
  if (new Set(value.options.map(option => option.id)).size !== value.options.length
    || new Set(value.options.map(option => option.label.normalize('NFKC'))).size !== value.options.length) return null;
  return { id: value.id, title: value.title, options: value.options.map(({ id, label }) => ({ id, label })), expiresAt: value.expiresAt };
}

/** Poll protocol state lives only in the private linked-device SQLite store.
 * rc14 does not emit decrypted pollUpdates: decrypt its encrypted upsert payload
 * explicitly. Never use display names, aggregates or plaintext votes as identity.
 */
export function createPollChoices({ store, config, proto, generateWAMessageContent, decryptPollVote,
  normalizeMessageContent = value => value, now = Date.now, timeoutMs = 15_000 }) {
  if (!proto?.Message?.encode || !proto?.Message?.decode || typeof generateWAMessageContent !== 'function'
    || typeof decryptPollVote !== 'function') throw new Error('poll_protocol_unavailable');
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS choice_polls (
    id TEXT PRIMARY KEY,question_id TEXT NOT NULL,sender TEXT NOT NULL,chat_jid TEXT NOT NULL,
    recipient_jids TEXT NOT NULL,creator_jids TEXT NOT NULL,choices_json TEXT NOT NULL,message_proto BLOB,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,
    consumed_message_id TEXT,UNIQUE(sender,question_id));
    CREATE INDEX IF NOT EXISTS choice_polls_sender ON choice_polls(sender,state);`);
  // A process may have died after WhatsApp accepted the poll. Never blindly repeat it.
  db.exec("UPDATE choice_polls SET state='uncertain' WHERE state='sending'");
  function cleanup() {
    db.prepare("UPDATE choice_polls SET state='expired',message_proto=NULL WHERE expires_at<=? AND state!='expired'").run(now());
  }
  function pollContent(message) {
    try { return normalizeMessageContent(message?.message); } catch { return null; }
  }
  function outgoingMessage(key) {
    cleanup();
    if (!identifier(key?.id) || !privateJid(key?.remoteJid) || key.fromMe === false) return undefined;
    const row = db.prepare('SELECT * FROM choice_polls WHERE id=?').get(key.id);
    if (!row?.message_proto || !JSON.parse(row.recipient_jids).includes(key.remoteJid.replace(/:\d+(?=@)/, ''))) return undefined;
    try { return proto.Message.decode(Buffer.from(row.message_proto)); } catch { return undefined; }
  }
  // log(reason) is a diagnostics-only hook (default no-op, so existing callers/
  // tests that don't pass one see no behavior change): every rejection path
  // used to return the same bare 'fallback'/'uncertain' with nothing recorded
  // anywhere about *why*, which made a poll that silently never renders
  // unfixable to diagnose from the field -- the text fallback still went out,
  // so nothing looked broken except a missing poll no log line explained.
  // reason is always one of the fixed category strings below, never a raw
  // transport exception, message content, phone number or other secret --
  // same "no transport exception is exposed" rule the final catch already followed.
  async function sendQuestion({ choices: value, chatJid, senderNumber }, { identity, creatorJids, authorize, relay, log = () => {} }) {
    cleanup();
    const choices = normalizePollChoices(value, now());
    if (!choices) { log('bad_choices'); return { status: 'fallback' }; }
    if (!privateJid(chatJid)) { log('bad_chat_jid'); return { status: 'fallback' }; }
    if (senderNumber === config.botNumber) { log('sender_is_bot'); return { status: 'fallback' }; }
    if (!config.allowedNumbers.has(senderNumber)) { log('sender_not_allowed'); return { status: 'fallback' }; }
    if (!await authorize(senderNumber)) { log('not_authorized'); return { status: 'fallback' }; }
    if (await resolvePhone(chatJid, `${senderNumber}@s.whatsapp.net`, identity) !== senderNumber) { log('phone_mismatch'); return { status: 'fallback' }; }
    const creators = [...new Set(creatorJids.filter(privateJid).map(identity.normalizeJid))];
    if (!creators.length || creators.length > 2) { log(`bad_creator_count:${creators.length}`); return { status: 'fallback' }; }
    const canonical = `${senderNumber}@s.whatsapp.net`;
    const recipients = [...new Set([canonical, identity.normalizeJid(chatJid)])];
    const id = 'TITANIUMPOLL' + digest(JSON.stringify([senderNumber, choices.id])).toString('hex').slice(0, 32).toUpperCase();
    if (db.prepare('SELECT id FROM choice_polls WHERE id=?').get(id)) return { status: 'existing' };
    let content;
    try {
      content = await generateWAMessageContent({ poll: { name: choices.title,
        values: choices.options.map(option => option.label), selectableCount: 1, messageSecret: randomBytes(32) } }, {});
    } catch { log('generate_content_failed'); return { status: 'fallback' }; }
    if (!content?.pollCreationMessageV3 || content.messageContextInfo?.messageSecret?.length !== 32
      || !await authorize(senderNumber) || now() >= choices.expiresAt) { log('bad_poll_content_or_reauthorize_failed'); return { status: 'fallback' }; }
    const bytes = Buffer.from(proto.Message.encode(content).finish());
    const claimed = store.transaction(() => {
      if (db.prepare('SELECT id FROM choice_polls WHERE id=?').get(id)) return false;
      db.prepare("UPDATE choice_polls SET state='superseded',message_proto=NULL WHERE sender=? AND state IN ('sent','sending','uncertain')").run(senderNumber);
      db.prepare('INSERT INTO choice_polls(id,question_id,sender,chat_jid,recipient_jids,creator_jids,choices_json,message_proto,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, choices.id, senderNumber, canonical, JSON.stringify(recipients), JSON.stringify(creators), JSON.stringify(choices), bytes, now(), choices.expiresAt, 'sending');
      return true;
    });
    if (!claimed) return { status: 'existing' };
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // The persisted IMessage is the exact body relayed; meta matches Baileys sendMessage(poll).
      await withAbortSignal(async () => {
        if (!await authorize(senderNumber) || signal.aborted || now() >= choices.expiresAt) throw new Error('poll_unavailable');
        return relay(canonical, proto.Message.decode(bytes), { messageId: id,
          additionalNodes: [{ tag: 'meta', attrs: { polltype: 'creation' } }] }, signal);
      }, signal);
      db.prepare("UPDATE choice_polls SET state='sent' WHERE id=? AND state='sending'").run(id);
      return { status: 'sent' };
    } catch {
      log('relay_failed'); // Never echo the transport exception itself -- only that this category of thing happened.
      db.prepare("UPDATE choice_polls SET state='uncertain' WHERE id=? AND state='sending'").run(id);
      return { status: 'uncertain' }; // Text fallback was already sent; no transport exception is exposed.
    }
  }

  async function acceptVote(message, event, { identity, activatedAt, authorize }) {
    cleanup();
    const key = message?.key, content = pollContent(message), update = content?.pollUpdateMessage;
    if (event?.type !== 'notify' || event.requestId != null || !key || key.fromMe !== false || !update
      || !identifier(key.id) || !privateJid(key.remoteJid) || key.participant || key.participantAlt) return false;
    if (Object.keys(content).some(field => content[field] != null && !['pollUpdateMessage', 'messageContextInfo'].includes(field))) return false;
    const creation = update.pollCreationMessageKey;
    if (!creation || creation.fromMe !== true || !identifier(creation.id) || !privateJid(creation.remoteJid)) return false;
    const row = db.prepare('SELECT * FROM choice_polls WHERE id=?').get(creation.id);
    if (!row || !['sent', 'uncertain'].includes(row.state) || row.consumed_message_id || !row.message_proto || row.expires_at <= now()) return false;
    const sentAt = Number(message.messageTimestamp) * 1000, votedAt = Number(update.senderTimestampMs);
    // Timestamp is supplementary: it is not authenticated by poll GCM. Server question
    // expiry/current version plus the persisted one-use poll are the authority.
    for (const time of [sentAt, votedAt]) if (!Number.isSafeInteger(time) || time < row.created_at - 1000
      || time < activatedAt - 1000 || time < now() - 300_000 || time > now() + 60_000) return false;
    const sender = await resolvePhone(key.remoteJid, key.remoteJidAlt, identity);
    if (!sender || sender !== row.sender || sender === config.botNumber || !config.allowedNumbers.has(sender)
      || !await authorize(sender)) return false;
    if (await resolvePhone(creation.remoteJid, key.remoteJidAlt, identity) !== sender) return false;
    const creators = JSON.parse(row.creator_jids);
    // rc14 cleanMessage fills a missing direct-chat participant with ''.
    if (creation.participant && (!privateJid(creation.participant) || !creators.includes(identity.normalizeJid(creation.participant)))) return false;
    const voters = [...new Set([key.remoteJid, key.remoteJidAlt, `${sender}@s.whatsapp.net`].filter(privateJid).map(identity.normalizeJid))];
    if (!voters.length || voters.length > 2 || !update.vote?.encPayload || !update.vote.encIv
      || update.vote.encIv.length !== 12 || update.vote.encPayload.length < 17 || update.vote.encPayload.length > 4096) return false;
    let creationContent;
    try { creationContent = proto.Message.decode(Buffer.from(row.message_proto)); } catch { return false; }
    const secret = creationContent.messageContextInfo?.messageSecret;
    if (secret?.length !== 32) return false;
    let vote;
    for (const pollCreatorJid of creators) for (const voterJid of voters) {
      if (vote) break;
      try { vote = decryptPollVote(update.vote, { pollCreatorJid, voterJid, pollMsgId: row.id, pollEncKey: secret }); } catch { /* Reject unauthenticated aliases/ciphertext. */ }
    }
    if (!vote || !Array.isArray(vote.selectedOptions) || vote.selectedOptions.length !== 1) return false;
    const selected = Buffer.from(vote.selectedOptions[0]);
    if (selected.length !== 32) return false;
    const choices = JSON.parse(row.choices_json);
    const matches = choices.options.filter(option => timingSafeEqual(selected, digest(Buffer.from(option.label, 'utf8'))));
    if (matches.length !== 1 || !await authorize(sender)) return false;
    const option = matches[0];
    return store.transaction(() => {
      const current = db.prepare('SELECT state,consumed_message_id,expires_at FROM choice_polls WHERE id=?').get(row.id);
      if (!current || !['sent', 'uncertain'].includes(current.state) || current.consumed_message_id || current.expires_at <= now()) return false;
      const queued = store.enqueue({ chatJid: row.chat_jid, body: { messageId: key.id, senderNumber: sender,
        groupId: null, text: option.label, receivedAt: now(), inputKind: 'text',
        choice: { questionId: row.question_id, optionId: option.id } } });
      if (!queued) return false;
      db.prepare("UPDATE choice_polls SET consumed_message_id=?,state='consumed',message_proto=NULL WHERE id=?").run(key.id, row.id);
      return true;
    });
  }
  return { sendQuestion, acceptVote, outgoingMessage, cleanup, isPollVote: message => !!pollContent(message)?.pollUpdateMessage };
}
