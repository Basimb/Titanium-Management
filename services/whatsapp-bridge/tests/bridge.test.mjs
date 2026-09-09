import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { resolvePhone, selectIncoming } from '../src/identity.mjs';
import { openStore, createAuthState } from '../src/store.mjs';
import { signatureHeaders, deliverOne } from '../src/delivery.mjs';

const now = 1_800_000_000_000;
const member = '15551234567';
const botNumber = '15551234568';
const group = '120363000000000000@g.us';
const key = 'ab'.repeat(32);
const config = { botNumber, key, allowedNumbers: new Set([member]), allowedGroups: new Set(),
  backendUrl: 'https://example.com/api/whatsapp/team-chat' };
// Network-free test substitute; production injects Baileys.jidNormalizedUser.
const identity = { normalizeJid: jid => jid.replace(/:[0-9]+@/, '@'), lookupPhoneForLid: async () => null };
const msg = (overrides = {}) => ({ key: { id: 'WA_TEST_MESSAGE_1', remoteJid: `${member}@s.whatsapp.net`, fromMe: false },
  messageTimestamp: now / 1000, message: { conversation: 'خلصت مراجعة التقرير' }, ...overrides });
const select = (message, event = { type: 'notify' }, cfg = config, ids = identity) =>
  selectIncoming(message, event, cfg, ids, now, now - 10_000);

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-bridge-test-'));
  let store = openStore(directory);
  t.after(() => {
    store.close();
    // Cleanup is restricted to the exact temporary test directory just created.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-bridge-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { get store() { return store; }, restart() { store.close(); store = openStore(directory); return store; } };
}

function enqueue(store) {
  store.enqueue({ chatJid: `${member}@s.whatsapp.net`, body: { messageId: 'WA_TEST_MESSAGE_1', senderNumber: member,
    groupId: null, text: 'أنهيت المهمة', receivedAt: now } });
  return store.next(now);
}

test('config requires explicit valid senders, private state, HTTPS endpoint, and strong-shaped key', () => {
  const root = path.join(os.tmpdir(), 'fixture-repo', 'services', 'whatsapp-bridge');
  const env = { TEAM_CHAT_BOT_NUMBER: botNumber, TEAM_CHAT_ALLOWED_NUMBERS: '+' + member,
    TEAM_CHAT_SHARED_KEY: key, TEAM_CHAT_BACKEND_URL: config.backendUrl,
    TEAM_CHAT_STATE_DIR: path.join(os.tmpdir(), 'fixture-private-state') };
  const parsed = loadConfig(env, root);
  assert.deepEqual([...parsed.allowedNumbers], [member]);
  assert.equal(parsed.allowedGroups.size, 0);
  assert.equal(parsed.allowPairing, false);
  for (const change of [
    { TEAM_CHAT_ALLOWED_NUMBERS: '' }, { TEAM_CHAT_ALLOWED_NUMBERS: botNumber },
    { TEAM_CHAT_SHARED_KEY: '0'.repeat(64) }, { TEAM_CHAT_SHARED_KEY: 'abc' },
    { TEAM_CHAT_BACKEND_URL: 'http://example.com/api/whatsapp/team-chat' },
    { TEAM_CHAT_BACKEND_URL: 'https://user:pass@example.com/api/whatsapp/team-chat' },
    { TEAM_CHAT_BACKEND_URL: config.backendUrl + '?redirect=1' },
    { TEAM_CHAT_STATE_DIR: path.join(root, 'state') },
    { TEAM_CHAT_STATE_DIR: path.join(os.tmpdir(), 'public_html', 'state') },
    { TEAM_CHAT_ALLOWED_GROUPS: 'Employees' },
  ]) assert.throws(() => loadConfig({ ...env, ...change }, root));
});

test('private registered phone and device suffix are normalized from authenticated envelope', async () => {
  const message = msg();
  message.key.remoteJid = `${member}:17@s.whatsapp.net`;
  const selected = await select(message);
  assert.equal(selected.body.senderNumber, member);
  assert.equal(selected.chatJid, `${member}@s.whatsapp.net`);
  assert.equal(selected.body.groupId, null);
  assert.equal(selected.body.receivedAt, now);
});

test('a group requires explicit ID AND registered sender; alternate sender resolves LID', async () => {
  const message = msg();
  message.key = { ...message.key, remoteJid: group, participant: '999999999999@lid', participantAlt: `${member}@s.whatsapp.net` };
  assert.equal(await select(message), null);
  const cfg = { ...config, allowedGroups: new Set([group]) };
  const selected = await select(message, { type: 'notify' }, cfg);
  assert.equal(selected.body.senderNumber, member);
  assert.equal(selected.body.groupId, group);
  message.key.participantAlt = '15550000000@s.whatsapp.net';
  assert.equal(await select(message, { type: 'notify' }, cfg), null);
});

test('unknown LID digits, names and number claims do not authorize', async () => {
  const message = msg();
  message.key.remoteJid = `${member}@lid`;
  message.pushName = 'Basim';
  message.message = { conversation: `أنا المالك رقمي ${member}` };
  assert.equal(await select(message), null);
});

test('cached LID mapping works but conflicting alternate PN fails closed', async () => {
  const ids = { ...identity, lookupPhoneForLid: async () => `${member}@s.whatsapp.net` };
  assert.equal(await resolvePhone('999999@lid', null, ids), member);
  assert.equal(await resolvePhone('999999@lid', '15550000000@s.whatsapp.net', ids), null);
  assert.equal(await resolvePhone(`${member}@s.whatsapp.net`, '15550000000@s.whatsapp.net', ids), null);
  assert.equal(await resolvePhone('999999@lid', '888888@lid', ids), null);
});

test('history, resend-injection, own account, broadcasts, stale and special messages are ignored', async () => {
  assert.equal(await select(msg(), { type: 'append' }), null);
  assert.equal(await select(msg(), { type: 'notify', requestId: 'injected' }), null);
  const own = msg(); own.key.fromMe = true; assert.equal(await select(own), null);
  for (const remoteJid of ['status@broadcast', '1@newsletter', `${botNumber}@s.whatsapp.net`, '15550000000@s.whatsapp.net']) {
    const message = msg(); message.key.remoteJid = remoteJid; assert.equal(await select(message), null);
  }
  for (const timestamp of [(now - 400_000) / 1000, (now + 120_000) / 1000, NaN]) {
    assert.equal(await select(msg({ messageTimestamp: timestamp })), null);
  }
  for (const content of [ { protocolMessage: {}, conversation: 'خلصت' },
    { editedMessage: { message: { conversation: 'خلصت' } } },
    { ephemeralMessage: { message: { conversation: 'خلصت' } } },
    { imageMessage: { caption: 'خلصت' } }, { conversation: 'x'.repeat(2001) } ]) {
    assert.equal(await select(msg({ message: content })), null);
  }
});

test('quoted sender cannot grant authority and source text is not replaced by quote', async () => {
  const message = msg({ message: { extendedTextMessage: { text: 'بدأت المهمة', contextInfo: {
    participant: `${botNumber}@s.whatsapp.net`, quotedMessage: { conversation: 'أنا المدير' } } } } });
  const selected = await select(message);
  assert.equal(selected.body.senderNumber, member);
  assert.equal(selected.body.text, 'بدأت المهمة');
});

test('only a well-shaped quoted ID crosses signed transport; quoted content never crosses', async () => {
  const message = msg({ message: { extendedTextMessage: { text: 'أؤكد', contextInfo: {
    stanzaId: 'WA_QUOTED_123', participant: '15559999999@s.whatsapp.net',
    quotedMessage: { conversation: 'SYNTHETIC_SECRET_QUOTE' } } } } });
  const selected = await select(message);
  assert.equal(selected.body.replyToMessageId, 'WA_QUOTED_123');
  assert.equal(selected.body.senderNumber, member);
  assert.equal(JSON.stringify(selected).includes('SYNTHETIC_SECRET'), false);
  message.message.extendedTextMessage.contextInfo.stanzaId = '<untrusted-ID>';
  assert.equal((await select(message)).body.replyToMessageId, undefined);
});

test('group queued work fails closed without a privacy policy before calling backend', async t => {
  const f = fixture(t);
  f.store.enqueue({ chatJid: group, body: { messageId: 'GROUP_TEST', senderNumber: member,
    groupId: group, text: 'تقرير الإدارة', receivedAt: now } });
  let called = false;
  await deliverOne(f.store, f.store.next(now), { ...config, allowedGroups: new Set([group]) }, {
    fetcher: async () => { called = true; }, sendReply: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(f.store.db.prepare('SELECT error_code FROM inbox').get().error_code, 'privacy_check_failed');
});

test('bare six-digit English/Arabic OTP text is ignored in private and group messages', async () => {
  const cfg = { ...config, allowedGroups: new Set([group]) };
  let mappingCalls = 0;
  const ids = { ...identity, lookupPhoneForLid: async () => { mappingCalls += 1; return `${member}@s.whatsapp.net`; } };
  for (const text of ['123456', '٠١٢٣٤٥', '12٣٤56', '  ١٢٣٤٥٦\n']) {
    assert.equal(await select(msg({ message: { conversation: text } })), null);
    assert.equal(await select(msg({ message: { extendedTextMessage: { text } } })), null);
    const message = msg({ message: { conversation: text } });
    message.key = { ...message.key, remoteJid: group, participant: '999999999999@lid' };
    assert.equal(await select(message, { type: 'notify' }, cfg, ids), null);
  }
  assert.equal(mappingCalls, 0, 'the OTP is discarded before sender mapping or queue creation');
});

test('the narrow OTP filter preserves normal task text and other numeric lengths', async () => {
  for (const text of ['12345', '1234567', 'أنهيت المهمة رقم 123456', 'بدأت المهمة رقم ١٢٣٤٥٦']) {
    const selected = await select(msg({ message: { conversation: text } }));
    assert.equal(selected.body.text, text);
  }
});

test('HMAC uses raw UTF-8 body, hex-decoded secret and millisecond timestamp', () => {
  const raw = JSON.stringify({ text: 'أنهيت المهمة', receivedAt: now });
  const headers = signatureHeaders(raw, key, now);
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(`${now}\n${raw}`).digest('hex');
  assert.equal(headers['x-titanium-chat-timestamp'], String(now));
  assert.equal(headers['x-titanium-chat-signature'], expected);
  assert.notEqual(signatureHeaders(raw + ' ', key, now)['x-titanium-chat-signature'], expected);
});

test('durable queue preserves body, rejects duplicate IDs, survives restart and reuses reply ID', t => {
  const f = fixture(t);
  const initial = enqueue(f.store);
  assert.equal(JSON.parse(initial.raw_body).responseMessageId, initial.reply_id);
  assert.equal(f.store.enqueue({ chatJid: initial.chat_jid, body: JSON.parse(initial.raw_body) }), false);
  const restarted = f.restart().next(now);
  assert.equal(restarted.raw_body, initial.raw_body);
  assert.equal(restarted.reply_id, initial.reply_id);
  f.store.backendResult(initial.id, { status: 'applied', reply: 'تم تسجيل التحديث' });
  f.store.attemptReply(initial.id);
  const afterSendCrash = f.restart().next(now);
  assert.equal(afterSendCrash.state, 'reply');
  assert.equal(afterSendCrash.reply_attempts, 1);
  assert.equal(afterSendCrash.reply_id, initial.reply_id);
  assert.deepEqual(f.store.outgoingMessage({ id: initial.reply_id, remoteJid: initial.chat_jid }), { conversation: 'تم تسجيل التحديث' });
});

test('activation cutoff persists across process restarts', t => {
  const f = fixture(t);
  assert.equal(f.store.activate(now), now);
  assert.equal(f.restart().activate(now + 20_000), now);
});

test('state cannot be repurposed for another account and revoked allowlists cancel queued work', async t => {
  const f = fixture(t);
  f.store.bindAccount(botNumber);
  f.restart().bindAccount(botNumber);
  assert.throws(() => f.store.bindAccount(member));
  const row = enqueue(f.store);
  let called = false;
  await deliverOne(f.store, row, { ...config, allowedNumbers: new Set() }, {
    fetcher: async () => { called = true; }, sendReply: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(f.store.db.prepare('SELECT error_code FROM inbox').get().error_code, 'authorization_removed');
});

test('SQLite auth persists credentials, all Signal categories, null deletion and binary material', async t => {
  const f = fixture(t);
  const api = {
    BufferJSON: {
      replacer: (_key, value) => value instanceof Uint8Array ? { binary: [...value] } : value,
      reviver: (_key, value) => value?.binary ? Uint8Array.from(value.binary) : value,
    },
    initAuthCreds: () => ({ registered: false, secret: Uint8Array.from([1, 2, 3]) }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => ({ ...value, hydrated: true }) } } },
  };
  const auth = createAuthState(f.store, api);
  await auth.saveCreds({ registered: true });
  await auth.state.keys.set({ 'lid-mapping': { a: 'value' }, 'device-list': { b: [1, 2] },
    tctoken: { c: Uint8Array.from([4, 5]) }, 'app-state-sync-key': { d: { data: 'x' } } });
  const restored = createAuthState(f.restart(), api);
  assert.equal(restored.state.creds.registered, true);
  assert.deepEqual(restored.state.creds.secret, Uint8Array.from([1, 2, 3]));
  assert.equal((await restored.state.keys.get('lid-mapping', ['a'])).a, 'value');
  assert.deepEqual((await restored.state.keys.get('tctoken', ['c'])).c, Uint8Array.from([4, 5]));
  assert.equal((await restored.state.keys.get('app-state-sync-key', ['d'])).d.hydrated, true);
  await restored.state.keys.set({ 'lid-mapping': { a: null } });
  assert.equal((await restored.state.keys.get('lid-mapping', ['a'])).a, undefined);
});

test('backend retries identical body only on network, 429 and 503, then queues honest feedback without replay', async t => {
  const f = fixture(t);
  const initial = enqueue(f.store);
  const bodies = [];
  let clock = now;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = f.store.next(clock);
    assert.ok(row);
    await deliverOne(f.store, row, config, { now: () => clock,
      fetcher: async (_url, options) => {
        bodies.push(options.body);
        assert.equal(options.redirect, 'error');
        if (attempt === 0) throw new Error('network');
        return new Response('', { status: attempt % 2 ? 503 : 429 });
      } });
    clock += 60_000;
  }
  const feedback = f.store.next(clock);
  assert.equal(feedback.state, 'reply');
  assert.equal(feedback.reply_id, initial.reply_id);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(bodies[0], initial.raw_body);
  assert.equal(JSON.parse(feedback.result).status, 'unavailable');
  assert.equal(JSON.parse(feedback.result).failureReason, 'backend_429_exhausted');
});

test('backend timeout is bounded at 50 seconds and covers planning plus public search', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let suppliedSignal;
  await deliverOne(f.store, enqueue(f.store), config, {
    now: () => now,
    fetcher: async (_url, options) => {
      suppliedSignal = options.signal;
      return new Response(JSON.stringify({ status: 'ignored', reply: '' }), { status: 200 });
    },
  });
  assert.equal(timeout.mock.calls.length, 1);
  const [deadlineMs] = timeout.mock.calls[0].arguments;
  assert.equal(deadlineMs, 50_000);
  assert.ok(deadlineMs > 12_000);
  assert.ok(deadlineMs <= 55_000);
  assert.equal(suppliedSignal, controller.signal);
  assert.equal(f.store.db.prepare('SELECT state FROM inbox').get().state, 'done');
});

test('HTTP401/500 and malformed success result fail without reply or mutation retry', async t => {
  const f = fixture(t);
  for (const [index, response] of [new Response('', { status: 401 }), new Response('', { status: 500 }),
    new Response(JSON.stringify({ status: 'ok', reply: 5 }), { status: 200 }),
    new Response('x'.repeat(16_385), { status: 200 })].entries()) {
    const body = { messageId: `MSG_${index}`, senderNumber: member, groupId: null, text: 'خلصت', receivedAt: now + index };
    f.store.enqueue({ chatJid: `${member}@s.whatsapp.net`, body });
    await deliverOne(f.store, f.store.next(now + 100), config, { now: () => now, fetcher: async () => response });
  }
  assert.equal(f.store.next(now + 1_000_000), undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM inbox WHERE state='failed'").get().count, 4);
});

test('successful response is durable, never changes recipient and replies reuse outgoing ID', async t => {
  const f = fixture(t);
  const initial = enqueue(f.store);
  await deliverOne(f.store, initial, config, { now: () => now, fetcher: async () => new Response(JSON.stringify({
    status: 'applied', reply: 'تم تسجيل التحديث', taskId: 't1', recipient: 'attacker@s.whatsapp.net',
  }), { status: 200 }) });
  const row = f.restart().next(now);
  assert.equal(row.state, 'reply');
  const calls = [];
  const sendReply = async (...args) => { calls.push(args); if (calls.length === 1) throw Object.assign(new Error('disconnected'), { neverSent: true }); };
  await deliverOne(f.store, row, config, { now: () => now, sendReply });
  await deliverOne(f.store, f.store.next(now + 60_000), config, { now: () => now + 60_000, sendReply });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], initial.chat_jid);
  assert.equal(calls[0][2], calls[1][2]);
  assert.equal(f.store.next(now + 100_000), undefined);
  assert.equal(JSON.parse(row.result).recipient, undefined);
});

test('a reply send proved never to have reached the network (neverSent) is retried with the identical text and ID', async t => {
  const f = fixture(t);
  const initial = enqueue(f.store);
  await deliverOne(f.store, initial, config, { now: () => now, fetcher: async () => new Response(JSON.stringify({
    status: 'applied', reply: 'تم تسجيل التحديث',
  }), { status: 200 }) });
  const calls = [];
  const sendReply = async (...args) => { calls.push(args); throw Object.assign(new Error('not_connected'), { neverSent: true }); };
  let row = f.store.next(now);
  let clock = now;
  for (let attempt = 0; attempt < 3; attempt++) { await deliverOne(f.store, row, config, { now: () => clock, sendReply }); clock += 60_000; row = f.store.next(clock); }
  // Exhausted after exactly 3 attempts, never resent past that, but every
  // attempt reused the exact same text and message ID as the original.
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call[1], 'تم تسجيل التحديث'); assert.equal(call[2], initial.reply_id); }
  assert.equal(f.store.db.prepare('SELECT state,error_code FROM inbox').get().state, 'failed');
  assert.equal(f.store.db.prepare('SELECT error_code FROM inbox').get().error_code, 'reply_retry_exhausted');
});

test('an ambiguous reply-send failure (not proven to have missed WhatsApp) is never replayed, closing the duplicate-bubble bug', async t => {
  const f = fixture(t);
  const initial = enqueue(f.store);
  await deliverOne(f.store, initial, config, { now: () => now, fetcher: async () => new Response(JSON.stringify({
    status: 'applied', reply: 'تم تسجيل التحديث',
  }), { status: 200 }) });
  const calls = [];
  // Simulates Baileys' sendMessage() timing out on the delivery ack after the
  // text already reached WhatsApp's servers -- the exact scenario that used to
  // resend the identical guide text as a second, separate bubble.
  const sendReply = async (...args) => { calls.push(args); throw new Error('ack_timeout'); };
  const row = f.store.next(now);
  await deliverOne(f.store, row, config, { now: () => now, sendReply });
  assert.equal(calls.length, 1, 'must give up after the first ambiguous attempt, not resend');
  assert.equal(f.store.next(now + 1_000_000), undefined, 'nothing left queued to retry');
  const final = f.store.db.prepare('SELECT state,error_code FROM inbox').get();
  assert.equal(final.state, 'failed');
  assert.equal(final.error_code, 'reply_send_ambiguous');
});

test('empty backend reply completes silently', async t => {
  const f = fixture(t);
  await deliverOne(f.store, enqueue(f.store), config, { fetcher: async () =>
    new Response(JSON.stringify({ status: 'ignored', reply: '' })), now: () => now });
  assert.equal(f.store.next(now), undefined);
  assert.equal(f.store.db.prepare('SELECT state FROM inbox').get().state, 'done');
});
