import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as baileys from 'baileys';
import { openStore, createAuthState } from '../src/store.mjs';
import { createPollChoices, normalizePollChoices } from '../src/polls.mjs';
import { deliverOne } from '../src/delivery.mjs';
import { createBridgeRuntime } from '../src/runtime.mjs';

const BOT = '15551234568', MEMBER = '15551234567', OTHER = '15551234566';
const CLOCK = 1_800_000_000_000;
const choices = (id = 'Q_TEST', expiresAt = CLOCK + 300_000) => ({ id, title: 'شو أولوية المهمة؟',
  options: [{ id: 'O_HIGH', label: '1. عالية' }, { id: 'O_NORMAL', label: '2. عادية' }, { id: 'O_LOW', label: '3. منخفضة' }], expiresAt });

// Synthetic deterministic GCM fixture, never production material. Reimplements
// the installed Baileys poll derivation and uses its real decryptPollVote export.
function encryptedVote(content, id, creator, voter, labels, mutate = {}) {
  const pollKey = Buffer.from(content.messageContextInfo.messageSecret);
  const selectedOptions = labels.map(label => createHash('sha256').update(label).digest());
  const plaintext = baileys.proto.Message.PollVoteMessage.encode({ selectedOptions }).finish();
  const key0 = createHmac('sha256', Buffer.alloc(32)).update(pollKey).digest();
  const sign = Buffer.concat([Buffer.from(id), Buffer.from(creator), Buffer.from(voter), Buffer.from('Poll Vote'), Buffer.from([1])]);
  const key = createHmac('sha256', key0).update(sign).digest();
  const encIv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', key, encIv);
  cipher.setAAD(Buffer.from(`${id}\0${voter}`));
  const encPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { encIv, encPayload, ...mutate };
}

function fixture(t, { timeoutMs = 15_000 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-poll-test-'));
  let store = openStore(directory), clock = CLOCK, active = true;
  const config = { botNumber: BOT, allowedNumbers: new Set([MEMBER, OTHER]), allowedGroups: new Set(),
    key: 'ab'.repeat(32), backendUrl: 'https://example.invalid/api/whatsapp/team-chat' };
  const identity = { normalizeJid: baileys.jidNormalizedUser,
    lookupPhoneForLid: async jid => jid === '111111111@lid' ? `${MEMBER}@s.whatsapp.net` : null };
  const make = () => createPollChoices({ store, config, ...baileys, now: () => clock, timeoutMs });
  let polls = make();
  const sent = [];
  const authorize = async number => active && config.allowedNumbers.has(number);
  const send = (question = choices(), extra = {}) => polls.sendQuestion({ choices: question,
    chatJid: `${MEMBER}@s.whatsapp.net`, senderNumber: MEMBER, ...extra }, {
    identity, creatorJids: [`${BOT}:9@s.whatsapp.net`, '999999999@lid'], authorize,
    relay: async (jid, content, options) => {
      const stored = store.db.prepare('SELECT * FROM choice_polls WHERE id=?').get(options.messageId);
      assert.equal(stored.state, 'sending');
      assert.deepEqual(Buffer.from(baileys.proto.Message.encode(content).finish()), Buffer.from(stored.message_proto));
      sent.push({ jid, content, options });
    },
  });
  const vote = (extra = {}) => {
    const original = sent.at(-1);
    const voter = extra.voter || `${MEMBER}@s.whatsapp.net`;
    const creator = extra.creator || `${BOT}@s.whatsapp.net`;
    const labels = extra.labels || [choices().options[0].label];
    const payload = { key: { id: 'VOTE_TEST_1', remoteJid: voter, fromMe: false, ...extra.key },
      messageTimestamp: clock / 1000, message: { pollUpdateMessage: {
        pollCreationMessageKey: { id: original.options.messageId, remoteJid: voter, fromMe: true, ...extra.creation },
        senderTimestampMs: clock, vote: encryptedVote(original.content, original.options.messageId, creator, voter, labels),
      } } };
    return payload;
  };
  const accept = (message, event = { type: 'notify' }, overrides = {}) => polls.acceptVote(message, event, {
    identity, activatedAt: CLOCK - 60_000, authorize, ...overrides,
  });
  t.after(() => {
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-poll-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { send, vote, accept, sent, config, identity, authorize,
    get store() { return store; }, get polls() { return polls; }, get now() { return clock; },
    setActive(value) { active = value; }, tick(ms) { clock += ms; },
    restart() { store.close(); store = openStore(directory); polls = make(); },
  };
}

test('poll questions have exact bounded unique IDs/labels and 2..12 choices; unsupported values keep text fallback', () => {
  assert.deepEqual(normalizePollChoices(choices(), CLOCK), choices());
  for (const question of [null, { ...choices(), options: choices().options.slice(0, 1) },
    { ...choices(), options: Array.from({ length: 13 }, (_, i) => ({ id: `O${i}`, label: `Option ${i}` })) },
    { ...choices(), title: 'x'.repeat(101) }, { ...choices(), id: '../bad' }, { ...choices(), expiresAt: CLOCK },
    { ...choices(), options: [{ id: 'A', label: 'same' }, { id: 'B', label: 'same' }] },
    { ...choices(), options: [{ id: 'A', label: 'one' }, { id: 'A', label: 'two' }] },
    { ...choices(), options: [{ id: 'A', label: 'one\ntwo' }, { id: 'B', label: 'three' }] }]) {
    assert.equal(normalizePollChoices(question, CLOCK), null);
  }
});
// Basim runs a pharmacy business and doesn't always open WhatsApp within an
// hour of a task being submitted for his approval -- the old 60-minute
// ceiling here (shared by every poll this bridge sends, task-close decision
// included) meant a late tap silently did nothing, with no resend, which was
// the real mechanism behind an approval that "arrives" but never closes the
// task. The ceiling is now 24 hours; this pins that exact boundary so it
// cannot silently drift back down (or up) without a test noticing.
test('a poll may ask for up to 24 hours of validity, never more', () => {
  const DAY = 24 * 60 * 60_000;
  assert.deepEqual(normalizePollChoices(choices('Q_LONG', CLOCK + DAY), CLOCK), choices('Q_LONG', CLOCK + DAY));
  assert.equal(normalizePollChoices(choices('Q_TOO_LONG', CLOCK + DAY + 1), CLOCK), null);
});

test('poll proto and random secret are persisted before a single relay with required creation metadata', async t => {
  const f = fixture(t);
  assert.equal((await f.send()).status, 'sent');
  assert.equal(f.sent.length, 1);
  const poll = f.sent[0];
  assert.equal(poll.jid, `${MEMBER}@s.whatsapp.net`);
  assert.equal(poll.content.pollCreationMessageV3.selectableOptionsCount, 1);
  assert.equal(poll.content.messageContextInfo.messageSecret.length, 32);
  assert.deepEqual(poll.options.additionalNodes, [{ tag: 'meta', attrs: { polltype: 'creation' } }]);
  assert.equal((await f.send()).status, 'existing');
  assert.equal(f.sent.length, 1);
  const content = f.polls.outgoingMessage({ id: poll.options.messageId, remoteJid: poll.jid, fromMe: true });
  assert.deepEqual(content, poll.content);
  assert.equal(content.message, undefined); // getMessage requires IMessage, not WAMessage.
});

test('a resend with a fresh messageId replaces a previous still-active poll for the exact same question, instead of being silently swallowed as existing forever', async t => {
  const f = fixture(t);
  assert.equal((await f.send(choices(), { messageId: 'MSG_1' })).status, 'sent');
  assert.equal(f.sent.length, 1);
  const first = f.sent[0];
  // Same sender, same exact question (e.g. an explicit nudge, or the hourly
  // unclaimed-task reminder in agent-followups.ts, both of which intentionally
  // reuse the same choices.id every time) but a brand-new messageId, exactly
  // like a real second delivery attempt: this must create a genuinely new
  // WhatsApp poll, never silently report 'existing' and skip sending one.
  assert.equal((await f.send(choices(), { messageId: 'MSG_2' })).status, 'sent');
  assert.equal(f.sent.length, 2);
  const second = f.sent[1];
  assert.notEqual(first.options.messageId, second.options.messageId);
  const rows = f.store.db.prepare('SELECT id,state FROM choice_polls').all();
  assert.equal(rows.length, 1); // the stale row was replaced, not accumulated forever
  assert.equal(rows[0].id, second.options.messageId);
  assert.equal(rows[0].state, 'sent');
  // The old poll's own id is gone; a vote referencing it no longer resolves,
  // but the fresh one still does.
  assert.equal(f.polls.outgoingMessage({ id: first.options.messageId, remoteJid: first.jid, fromMe: true }), undefined);
  assert.equal(await f.accept(f.vote()), true);
  // A retry of the very same attempt (identical messageId) still dedupes exactly as before.
  assert.equal((await f.send(choices(), { messageId: 'MSG_2' })).status, 'existing');
  assert.equal(f.sent.length, 2);
});

test('real encrypted vote survives private-store restart and queues only the server-owned option identity', async t => {
  const f = fixture(t);
  await f.send();
  const before = f.sent[0].content.messageContextInfo.messageSecret;
  const vote = f.vote();
  f.restart();
  const restored = f.polls.outgoingMessage({ id: f.sent[0].options.messageId, remoteJid: `${MEMBER}@s.whatsapp.net` });
  assert.deepEqual(Buffer.from(restored.messageContextInfo.messageSecret), Buffer.from(before));
  assert.equal(await f.accept(vote), true);
  const row = f.store.next(f.now), body = JSON.parse(row.raw_body);
  assert.deepEqual(body.choice, { questionId: 'Q_TEST', optionId: 'O_HIGH' });
  assert.equal(body.text, choices().options[0].label);
  assert.equal(body.senderNumber, MEMBER);
  assert.equal(body.messageId, 'VOTE_TEST_1');
  assert.equal(body.inputKind, 'text');
  assert.equal(body.groupId, null);
  assert.equal(body.replyToMessageId, undefined);
  assert.ok(body.responseMessageId);
  assert.equal(JSON.stringify(body).includes(Buffer.from(before).toString('hex')), false);
  assert.equal(f.store.db.prepare('SELECT message_proto FROM choice_polls').get().message_proto, null);
});

test('LID crypto uses only consistent transport/mapping aliases and still requires the intended full phone', async t => {
  const f = fixture(t);
  await f.send();
  assert.equal(await f.accept(f.vote({ voter: '111111111@lid', creator: '999999999@lid',
    key: { remoteJidAlt: `${MEMBER}@s.whatsapp.net` } })), true);
  assert.equal(JSON.parse(f.store.next(f.now).raw_body).senderNumber, MEMBER);
});

test('supported ephemeral wrappers normalize the encrypted vote without weakening envelope checks', async t => {
  const f = fixture(t); await f.send();
  const message = f.vote();
  message.message = { ephemeralMessage: { message: message.message } };
  assert.equal(f.polls.isPollVote(message), true);
  assert.equal(await f.accept(message, { type: 'append' }), false);
  assert.equal(await f.accept(message), true);
});

test('actual rc14 cleanMessage normalizes recipient perspective and empty direct participants before crypto verification', async t => {
  const f = fixture(t); await f.send();
  const message = f.vote({ creation: { fromMe: false, remoteJid: `${BOT}@s.whatsapp.net` } });
  baileys.cleanMessage(message, `${BOT}@s.whatsapp.net`, '999999999@lid');
  assert.equal(message.key.participant, '');
  assert.equal(message.message.pollUpdateMessage.pollCreationMessageKey.participant, '');
  assert.equal(message.message.pollUpdateMessage.pollCreationMessageKey.fromMe, true);
  assert.equal(message.message.pollUpdateMessage.pollCreationMessageKey.remoteJid, `${MEMBER}@s.whatsapp.net`);
  assert.equal(await f.accept(message), true);
});

test('duplicate, simultaneous and changed votes consume one question atomically once', async t => {
  const f = fixture(t); await f.send();
  const first = f.vote(), changed = f.vote({ key: { id: 'VOTE_TEST_2' }, labels: [choices().options[1].label] });
  const results = await Promise.all([f.accept(first), f.accept(first), f.accept(changed)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get().n, 1);
  f.restart();
  assert.equal(await f.accept(changed), false);
});

test('a rejected vote logs a fixed, non-sensitive reason -- Basim tapping a real poll option that never reached the server was previously silent with nothing to diagnose', async t => {
  const f = fixture(t); await f.send();
  const KNOWN = new Set(['envelope_invalid', 'unexpected_participant', 'unexpected_content_fields', 'creation_key_invalid',
    'poll_not_found_or_consumed', 'timestamp_out_of_range', 'sender_unauthorized', 'creation_sender_mismatch',
    'creator_participant_mismatch', 'voter_or_payload_invalid', 'poll_proto_decode_failed', 'poll_secret_invalid',
    'vote_decrypt_failed', 'selected_option_invalid', 'option_not_matched', 'sender_reauthorize_failed',
    'poll_state_changed', 'enqueue_failed']);
  let reasons = [];
  const log = reason => reasons.push(reason);
  // An unknown poll id: never found in choice_polls.
  assert.equal(await f.accept(f.vote({ creation: { id: 'UNKNOWN_POLL' } }), { type: 'notify' }, { log }), false);
  assert.deepEqual(reasons, ['poll_not_found_or_consumed']);
  // A stray participant field on what should be a private-chat vote -- the
  // leading suspect behind a real WhatsApp tap that never surfaces here at all.
  reasons = [];
  assert.equal(await f.accept(f.vote({ key: { participant: `${MEMBER}@s.whatsapp.net` } }), { type: 'notify' }, { log }), false);
  assert.deepEqual(reasons, ['unexpected_participant']);
  // Every other rejection path still logs exactly one known, PII-free reason
  // (never a phone number, message text/label or raw transport exception).
  const cases = [f.vote({ creation: { fromMe: false } }), f.vote({ key: { fromMe: true } }),
    f.vote({ key: { remoteJid: '12345@g.us' } }), f.vote({ creation: { remoteJid: '12345@g.us' } }),
    f.vote({ voter: `${OTHER}@s.whatsapp.net` }), f.vote({ key: { remoteJidAlt: `${OTHER}@s.whatsapp.net` } }),
    f.vote({ creation: { participant: `${OTHER}@s.whatsapp.net` } }),
    (() => { const v = f.vote(); v.message.pollUpdateMessage.vote.encPayload[0] ^= 1; return v; })()];
  for (const message of cases) {
    reasons = [];
    assert.equal(await f.accept(message, { type: 'notify' }, { log }), false);
    assert.equal(reasons.length, 1);
    assert.ok(KNOWN.has(reasons[0]), `unexpected reason: ${reasons[0]}`);
    assert.doesNotMatch(reasons[0], new RegExp(`${MEMBER}|${OTHER}|SYNTHETIC`));
  }
  // A genuinely accepted vote logs nothing at all.
  reasons = [];
  assert.equal(await f.accept(f.vote(), { type: 'notify' }, { log }), true);
  assert.deepEqual(reasons, []);
});

test('unknown poll, groups, history, outgoing votes, other recipients and mismatched private keys never queue', async t => {
  const f = fixture(t); await f.send();
  const cases = [f.vote({ creation: { id: 'UNKNOWN_POLL' } }), f.vote({ creation: { fromMe: false } }),
    f.vote({ key: { fromMe: true } }), f.vote({ key: { remoteJid: '12345@g.us' } }),
    f.vote({ creation: { remoteJid: '12345@g.us' } }), f.vote({ voter: `${OTHER}@s.whatsapp.net` }),
    f.vote({ key: { remoteJidAlt: `${OTHER}@s.whatsapp.net` } }),
    f.vote({ creation: { participant: `${OTHER}@s.whatsapp.net` } }), f.vote({ key: { participant: `${MEMBER}@s.whatsapp.net` } })];
  for (const message of cases) assert.equal(await f.accept(message), false);
  assert.equal(await f.accept(f.vote(), { type: 'append' }), false);
  assert.equal(await f.accept(f.vote(), { type: 'notify', requestId: 'history-sync' }), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get().n, 0);
});

test('GCM tampering, wrong authenticated aliases, unknown hashes, multiple selections and vote removal are denied', async t => {
  const f = fixture(t); await f.send();
  const tampered = f.vote(); tampered.message.pollUpdateMessage.vote.encPayload[0] ^= 1;
  for (const message of [tampered, f.vote({ creator: '123456789@lid' }),
    f.vote({ voter: '111111111@lid', key: { remoteJid: `${MEMBER}@s.whatsapp.net` }, creation: { remoteJid: `${MEMBER}@s.whatsapp.net` } }),
    f.vote({ labels: ['not an actual option'] }), f.vote({ labels: [] }),
    f.vote({ labels: choices().options.map(option => option.label) })]) assert.equal(await f.accept(message), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get().n, 0);
});

test('freshness, expiry, superseded questions and active-user changes remain fail closed', async t => {
  const f = fixture(t); await f.send();
  const stale = f.vote(); stale.message.pollUpdateMessage.senderTimestampMs -= 600_000;
  assert.equal(await f.accept(stale), false);
  const future = f.vote(); future.messageTimestamp += 70;
  assert.equal(await f.accept(future), false);
  f.setActive(false); assert.equal(await f.accept(f.vote()), false); f.setActive(true);
  let checks = 0;
  assert.equal(await f.accept(f.vote(), { type: 'notify' }, { authorize: async () => ++checks === 1 }), false);
  const oldVote = f.vote(); await f.send(choices('Q_NEW'));
  assert.equal(await f.accept(oldVote), false);
  const latest = f.vote(); f.tick(300_001);
  assert.equal(await f.accept(latest), false);
  assert.equal(f.polls.outgoingMessage({ id: f.sent.at(-1).options.messageId, remoteJid: `${MEMBER}@s.whatsapp.net` }), undefined);
});

test('poll failure and interrupted send are terminal, secret-backed vote can prove an uncertain poll existed', async t => {
  const f = fixture(t);
  const send = () => f.polls.sendQuestion({ choices: choices(), chatJid: `${MEMBER}@s.whatsapp.net`, senderNumber: MEMBER }, {
    identity: f.identity, creatorJids: [`${BOT}@s.whatsapp.net`], authorize: f.authorize,
    relay: async (jid, content, options) => { f.sent.push({ jid, content, options }); throw Error('SYNTHETIC_PRIVATE_EXCEPTION'); },
  });
  assert.deepEqual(await send(), { status: 'uncertain' });
  f.restart();
  assert.deepEqual(await send(), { status: 'existing' });
  assert.equal(f.sent.length, 1);
  assert.equal(await f.accept(f.vote()), true);
});

test('unsupported, group and revoked questions are text-only and never create poll state', async t => {
  const f = fixture(t);
  assert.equal((await f.send({ ...choices(), options: choices().options.slice(0, 1) })).status, 'fallback');
  assert.equal((await f.send(choices(), { chatJid: '12345@g.us' })).status, 'fallback');
  assert.equal((await f.send(choices(), { senderNumber: BOT, chatJid: `${BOT}@s.whatsapp.net` })).status, 'fallback');
  f.setActive(false); assert.equal((await f.send()).status, 'fallback');
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM choice_polls').get().n, 0);
});

test('bounded backend choices persist through retry without accepting a recipient or damaging text fallback', async t => {
  const f = fixture(t);
  f.store.enqueue({ chatJid: `${MEMBER}@s.whatsapp.net`, body: { messageId: 'TEXT_1', senderNumber: MEMBER, groupId: null, text: 'أضف مهمة', receivedAt: f.now } });
  const fetcher = async () => Response.json({ status: 'clarify', reply: 'شو أولوية المهمة؟', choices: choices(), to: 'attacker@example.test' });
  await deliverOne(f.store, f.store.next(f.now), f.config, { fetcher, now: () => f.now, authorizeChat: async () => true });
  const row = f.store.next(f.now);
  const result = JSON.parse(row.result);
  assert.deepEqual(result.choices, choices());
  assert.equal(result.to, undefined);
  let callback;
  await deliverOne(f.store, row, f.config, { now: () => f.now, authorizeChat: async () => true,
    sendReply: async (...args) => { callback = args; } });
  assert.equal(callback[0], `${MEMBER}@s.whatsapp.net`);
  assert.deepEqual(callback[4].choices, choices());
  assert.equal(f.store.next(f.now), undefined);
});

async function runtimeFixture(t, f, rejectPoll = false) {
  const callbacks = [], texts = [], requests = [], output = [];
  const auth = createAuthState(f.store, baileys);
  auth.state.creds.registered = true;
  auth.state.creds.me = { id: `${BOT}:9@s.whatsapp.net`, lid: '999999999@lid' };
  let socket;
  const runtime = createBridgeRuntime({ ...baileys, config: f.config, store: f.store, auth,
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    makeCacheableSignalKeyStore: keys => keys, now: () => f.now,
    timers: { setInterval: fn => { callbacks.push(fn); return fn; }, clearInterval() {}, setTimeout, clearTimeout },
    makeWASocket(options) {
      socket = { options, ev: new EventEmitter(), get user() { return auth.state.creds.me; },
        signalRepository: { lidMapping: { getPNForLID: f.identity.lookupPhoneForLid } }, end() {},
        async sendMessage(jid, content, settings) { texts.push({ jid, content, settings }); },
        async relayMessage(jid, content, options) {
          const restored = await socket.options.getMessage({ remoteJid: jid, id: options.messageId, fromMe: true });
          assert.deepEqual(restored, content);
          f.sent.push({ jid, content, options });
          if (rejectPoll) throw Error('SYNTHETIC_PRIVATE_RELAY_ERROR');
        },
      };
      return socket;
    },
    isActiveNumber: f.authorize,
    fetcher: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json(requests.length === 1
        ? { status: 'clarify', reply: 'شو أولوية المهمة؟ يمكنك الاختيار أو الرد كتابة.', choices: choices() }
        : { status: 'confirmation', reply: 'راجع التفاصيل ثم أكد رمز المعاينة.' });
    },
    output: { info: value => output.push(value), error: value => output.push(value) },
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  await runtime.start();
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  assert.equal(runtime.status().ready, true);
  t.after(() => runtime.stop('service_shutdown'));
  return { socket, runtime, texts, requests, output, flush,
    async tick() { callbacks[0](); await flush(); },
  };
}

test('runtime delivers text fallback, one poll, authenticated vote and deterministic backend choice', async t => {
  const f = fixture(t), h = await runtimeFixture(t, f);
  h.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'REQUEST_POLL', fromMe: false, remoteJid: `${MEMBER}@s.whatsapp.net` },
    messageTimestamp: f.now / 1000, message: { conversation: 'أضف مهمة تجريبية' } }] });
  await h.flush();
  await h.tick(); await h.tick();
  assert.equal(f.sent.length, 1);
  assert.match(h.texts[0].content.text, /الاختيار أو الرد كتابة/);
  const vote = f.vote({ creation: { fromMe: false, remoteJid: `${BOT}@s.whatsapp.net` } });
  baileys.cleanMessage(vote, `${BOT}@s.whatsapp.net`, '999999999@lid');
  h.socket.ev.emit('messages.upsert', { type: 'notify', messages: [vote, vote] });
  await h.flush();
  await h.tick(); await h.tick();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].choice, { questionId: 'Q_TEST', optionId: 'O_HIGH' });
  assert.equal(h.requests[1].replyToMessageId, undefined);
  assert.equal(f.sent.length, 1);
  assert.equal(h.runtime.status().ready, true);
  assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC|messageSecret|155512345/);
});

test('ambiguous poll transport failure keeps the successful text, does not repeat the poll and does not stall later delivery', async t => {
  const f = fixture(t), h = await runtimeFixture(t, f, true);
  f.store.enqueue({ chatJid: `${MEMBER}@s.whatsapp.net`, body: { messageId: 'REQUEST_FAILING_POLL', senderNumber: MEMBER, groupId: null, text: 'أضف مهمة', receivedAt: f.now } });
  await h.tick(); await h.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM choice_polls').get().state, 'uncertain');
  assert.equal(f.store.next(f.now), undefined);
  f.store.enqueue({ chatJid: `${MEMBER}@s.whatsapp.net`, body: { messageId: 'FOLLOWUP', senderNumber: MEMBER, groupId: null, text: 'شكرا', receivedAt: f.now } });
  await h.tick(); await h.tick();
  assert.equal(h.texts.filter(item => item.content.text.includes('راجع التفاصيل')).length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(h.runtime.status().ready, true);
  assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC_PRIVATE_RELAY_ERROR/);
});
