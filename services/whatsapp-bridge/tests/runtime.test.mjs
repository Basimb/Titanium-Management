import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as baileys from 'baileys';
import pino from 'pino';
import { openStore, createAuthState } from '../src/store.mjs';
import { createBridgeRuntime } from '../src/runtime.mjs';

const clock = 1_800_000_000_000;
const botNumber = '15551234568';
const member = '15551234567';
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { paired = true, ownNumber = botNumber, allowPairing = false,
  isActiveNumber = number => number === member, control, secretaryJobs, secretaryOutbox } = {}) {
  if (secretaryOutbox && typeof secretaryOutbox.recordTransportUpdate !== 'function') secretaryOutbox.recordTransportUpdate = () => ({ status: 'recorded' });
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-bridge-runtime-test-'));
  const store = openStore(directory);
  const logger = pino({ level: 'silent' });
  const auth = createAuthState(store, baileys);
  auth.state.creds.registered = paired;
  if (paired) auth.state.creds.me = { id: `${ownNumber}:9@s.whatsapp.net`, name: 'Synthetic test account' };
  const sockets = [];
  const stopped = [];
  const output = [];
  const timerJobs = [];
  const intervals = [];
  const config = { botNumber, allowPairing, allowedNumbers: new Set([member]), allowedGroups: new Set(),
    key: 'ab'.repeat(32), backendUrl: 'https://example.com/api/whatsapp/team-chat' };
  const timers = {
    setTimeout(fn, delay) { const job = { fn, delay, cleared: false }; timerJobs.push(job); return job; },
    clearTimeout(job) { if (job) job.cleared = true; },
    setInterval(fn, delay) { const job = { fn, delay, cleared: false }; intervals.push(job); return job; },
    clearInterval(job) { if (job) job.cleared = true; },
  };
  const runtime = createBridgeRuntime({
    ...baileys, config, store, auth, logger, now: () => clock, timers, isActiveNumber, control, secretaryJobs, secretaryOutbox,
    makeWASocket(options) {
      // Never call the actual Baileys factory. Every network-capable method is mocked.
      const socket = { options, ev: new EventEmitter(), ws: new EventEmitter(), authState: options.auth, pairCalls: [], endCalls: 0,
        get user() { return options.auth.creds.me; },
        signalRepository: { lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null } },
        async requestPairingCode(number) { this.pairCalls.push(number); return 'TESTCODE'; },
        end() { this.endCalls += 1; },
        async groupMetadata() { throw new Error('Unexpected group request'); },
        async getUSyncDevices(jids) { return jids.map(jid => ({ jid })); },
        async relayMessage() { throw new Error('Unexpected outgoing relay'); },
        async sendMessage() { throw new Error('Unexpected outgoing message'); },
      };
      sockets.push(socket);
      return socket;
    },
    fetcher: async () => { throw new Error('External requests are forbidden in runtime tests'); },
    onStop: reason => stopped.push(reason),
    output: { info: message => output.push(message), error: message => output.push(message) },
  });
  t.after(() => {
    runtime.stop('service_shutdown');
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-bridge-runtime-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { config, store, auth, sockets, stopped, output, timerJobs, intervals, runtime };
}

test('fresh group privacy check blocks queued sensitive reply if outsider joins or account is disabled', async t => {
  const group = '120363000000000000@g.us';
  let active = true;
  const h = harness(t, { isActiveNumber: () => active });
  h.config.allowedGroups.add(group);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  let queries = 0;
  let outsider = false;
  socket.groupMetadata = async () => { queries++; return { id: group, size: outsider ? 3 : 2, participants: [
    { id: `${botNumber}@s.whatsapp.net` }, { id: `${member}@s.whatsapp.net` },
    ...(outsider ? [{ id: '15559999999@s.whatsapp.net' }] : [])] }; };
  const sent = [];
  socket.sendMessage = async (...args) => sent.push(args);
  const enqueueReply = id => {
    h.store.enqueue({ chatJid: group, body: { messageId: id, senderNumber: member, groupId: group, text: 'تقرير', receivedAt: clock } });
    const row = h.store.next(clock); h.store.backendResult(row.id, { status: 'report', reply: 'SENSITIVE_REPORT' });
  };
  enqueueReply('FIRST');
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(sent.length, 1);
  assert.ok(queries >= 2, 'before delivery and immediately before actual send both fetch fresh');
  outsider = true;
  enqueueReply('SECOND'); h.intervals[0].fn(); await flush(); await flush();
  assert.equal(sent.length, 1);
  assert.equal(h.store.db.prepare("SELECT error_code FROM inbox WHERE json_extract(raw_body,'$.messageId')='SECOND'").get().error_code, 'privacy_check_failed');
  outsider = false; active = false;
  enqueueReply('THIRD'); h.intervals[0].fn(); await flush(); await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(h.stopped, []);
});

test('group membership update during metadata authorization invalidates the send', async t => {
  const group = '120363000000000000@g.us';
  const h = harness(t);
  h.config.allowedGroups.add(group);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  socket.groupMetadata = async () => {
    socket.ev.emit('group-participants.update', { id: group, action: 'add' });
    return { id: group, size: 2, participants: [{ id: `${botNumber}@s.whatsapp.net` }, { id: `${member}@s.whatsapp.net` }] };
  };
  h.store.enqueue({ chatJid: group, body: { messageId: 'RACE', senderNumber: member, groupId: group, text: 'تقرير', receivedAt: clock } });
  h.store.backendResult(h.store.next(clock).id, { status: 'report', reply: 'SENSITIVE_REPORT' });
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(h.store.db.prepare('SELECT error_code FROM inbox').get().error_code, 'privacy_check_failed');
  assert.deepEqual(h.stopped, []);
});

test('installed Baileys exports and real auth serialization are compatible without a socket', async t => {
  for (const name of ['default', 'initAuthCreds', 'jidNormalizedUser', 'makeCacheableSignalKeyStore']) {
    assert.equal(typeof baileys[name], 'function');
  }
  assert.equal(baileys.jidNormalizedUser(`${member}:17@s.whatsapp.net`), `${member}@s.whatsapp.net`);
  const h = harness(t);
  await h.auth.saveCreds();
  await h.auth.state.keys.set({ tctoken: { fake: Buffer.from([1, 2, 3]) },
    'app-state-sync-key': { fake: { keyData: Buffer.from([4, 5, 6]) } },
    'lid-mapping': { fake: `${member}@s.whatsapp.net` }, 'device-list': { fake: ['0', '1'] } });
  const reloaded = createAuthState(h.store, baileys);
  assert.ok(Buffer.isBuffer(reloaded.state.creds.noiseKey.private));
  assert.deepEqual((await reloaded.state.keys.get('tctoken', ['fake'])).fake, Buffer.from([1, 2, 3]));
  assert.deepEqual((await reloaded.state.keys.get('app-state-sync-key', ['fake'])).fake.keyData, Buffer.from([4, 5, 6]));
  assert.equal(h.sockets.length, 0);
});

test('scheduled secretary jobs keep private recipients allowlisted and abort hung sends without stopping the runtime', async t => {
  const controller = new AbortController();
  let attempted = false;
  const h = harness(t, { secretaryJobs: { async deliverNext(send) {
    for (const to of ['15559999999@s.whatsapp.net', 'attacker@lid', botNumber]) {
      await assert.rejects(() => send({ to, text: 'PRIVATE_REMINDER', messageId: 'REMINDER_SAFE_ID', signal: controller.signal }));
    }
    attempted = true;
    await assert.rejects(() => send({ to: member, text: 'PRIVATE_REMINDER', messageId: 'REMINDER_SAFE_ID', signal: controller.signal }));
    return { status: 'failed' };
  } } });
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  socket.sendMessage = async () => { controller.abort(); return new Promise(() => {}); };
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(attempted, true);
  assert.deepEqual(h.stopped, []);
  assert.match(h.output.join('\n'), /Titanium secretary delivery: failed/);
  assert.doesNotMatch(h.output.join('\n'), /PRIVATE_REMINDER|1555/);
});

test('scheduled group delivery checks latest membership and never uses an outsider group', async t => {
  const group = '120363000000000000@g.us';
  const h = harness(t, { secretaryJobs: { async deliverNext(send) {
    await assert.rejects(() => send({ to: group, text: 'PRIVATE_REMINDER', messageId: 'REMINDER_SAFE_ID', signal: new AbortController().signal }));
    return { status: 'failed' };
  } } });
  h.config.allowedGroups.add(group);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  let queries = 0;
  socket.groupMetadata = async () => { queries++; return { id: group, size: 3, participants: [
    { id: `${botNumber}@s.whatsapp.net` }, { id: `${member}@s.whatsapp.net` }, { id: '15559999999@s.whatsapp.net' }] }; };
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(queries, 1);
  assert.deepEqual(h.stopped, []);
});

test('disabled task automation pauses secretary jobs', async t => {
  let jobs = 0;
  const h = harness(t, { secretaryJobs: { deliverNext: async () => { jobs++; return { status: 'idle' }; } } });
  h.config.tasksEnabled = false;
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' }); await flush();
  h.intervals[0].fn(); await flush();
  assert.equal(jobs, 0);
});

test('private outbox sends exact approved text only on the verified linked account without pairing or content logs', async t => {
  const text = 'نص تجريبي وافق عليه صاحب الطلب\nرسالة خاصة لكل موظف.';
  const owner = '15551230000';
  let calls = 0;
  const h = harness(t, { isActiveNumber: number => [owner, member].includes(number), secretaryOutbox: { async deliverNext(send) {
    calls++;
    await send({ to: `${member}@s.whatsapp.net`, text, messageId: 'TITANIUMOUT_SYNTHETIC', signal: new AbortController().signal });
    await send({ to: `${owner}@s.whatsapp.net`, text: 'SYNTHETIC_PRIVATE_RECEIPT', messageId: 'TITANIUMOUTSUMMARY_SYNTHETIC', signal: new AbortController().signal });
    return { status: 'submitted' };
  } } });
  h.config.allowedNumbers.add(owner);
  await h.runtime.start();
  const socket = h.sockets[0];
  const sent = [];
  socket.relayMessage = async (jid, message, options) => {
    sent.push([jid, message, options]);
    socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: jid, id: options.messageId } });
  };
  h.intervals[0].fn(); await flush();
  assert.equal(calls, 0);
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(calls, 1);
  assert.equal(sent[0][0], `${member}@s.whatsapp.net`);
  assert.equal(sent[0][1].extendedTextMessage.text, text);
  assert.equal(sent[0][1].extendedTextMessage.jpegThumbnail ?? null, null);
  assert.deepEqual(sent[0][2], { messageId: 'TITANIUMOUT_SYNTHETIC' });
  const persisted = h.store.db.prepare('SELECT message_proto,server_ack_at FROM private_outbox_transport WHERE message_id=?').get('TITANIUMOUT_SYNTHETIC');
  assert.equal(persisted.server_ack_at, clock);
  assert.deepEqual(Buffer.from(persisted.message_proto), Buffer.from(baileys.proto.Message.encode(sent[0][1]).finish()));
  const retry = await socket.options.getMessage({ id: 'TITANIUMOUT_SYNTHETIC', remoteJid: `${member}@s.whatsapp.net`, fromMe: true });
  assert.equal(retry.extendedTextMessage.text, text);
  assert.equal(sent[1][0], `${owner}@s.whatsapp.net`);
  assert.deepEqual(socket.pairCalls, []);
  assert.deepEqual(h.stopped, []);
  assert.ok(h.auth.state.creds.registered);
  assert.doesNotMatch(h.output.join('\n'), /1555|SYNTHETIC|نص تجريبي/);
  assert.match(h.output.join('\n'), /Titanium secretary outbox: submitted/);
});

test('private outbox rejects every group, noncanonical recipient, revoked user, altered text and invalid send identifier', async t => {
  const group = '120363000000000000@g.us';
  const disabled = '15551230000';
  const h = harness(t, { secretaryOutbox: { async deliverNext(send) {
    for (const override of [
      ...[group, `${member}@lid`, 'status@broadcast', `${member}@newsletter`, member, `+${member}@s.whatsapp.net`,
        `${botNumber}@s.whatsapp.net`, '15559999999@s.whatsapp.net', `${disabled}@s.whatsapp.net`].map(to => ({ to })),
      { messageId: 'bad identifier' }, { messageId: '' }, { text: 'changed\u202etext' }, { text: ' text ' },
      { text: 'a\r\nb' }, { text: 'x'.repeat(4001) }, { text: '' }, { signal: AbortSignal.abort() },
    ]) await assert.rejects(() => send({ to: `${member}@s.whatsapp.net`, text: 'SYNTHETIC_PRIVATE_TEXT',
      messageId: 'TITANIUMOUT_SYNTHETIC', signal: new AbortController().signal, ...override }));
    return { status: 'failed' };
  } } });
  h.config.allowedGroups.add(group);
  h.config.allowedNumbers.add(disabled);
  h.config.allowedNumbers.add(botNumber); // A malformed allowlist must not permit self-send.
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' }); await flush();
  h.intervals[0].fn(); await flush(); await flush();
  assert.deepEqual(h.stopped, []);
  assert.match(h.output.join('\n'), /Titanium secretary outbox: failed/);
});

test('private outbox rechecks connection and allowlist after asynchronous account authorization', async t => {
  let authorize;
  const h = harness(t, { isActiveNumber: () => new Promise(resolve => { authorize = resolve; }),
    secretaryOutbox: { async deliverNext(send) {
      await assert.rejects(() => send({ to: `${member}@s.whatsapp.net`, text: 'PRIVATE', messageId: 'TITANIUMOUT_RACE', signal: new AbortController().signal }));
      return { status: 'failed' };
    } } });
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  h.intervals[0].fn(); await flush();
  assert.equal(typeof authorize, 'function');
  h.config.allowedNumbers.delete(member);
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  authorize(true); await flush(); await flush();
  assert.equal(h.runtime.status().ready, false);
  assert.deepEqual(h.stopped, []);
});

test('aborted ambiguous outbox delivery does not hang or tear down subsequent secretary job delivery', async t => {
  const controller = new AbortController();
  let reminderReady = false;
  const h = harness(t, { secretaryJobs: { async deliverNext(send) {
    if (!reminderReady) return { status: 'idle' };
    await send({ to: member, text: 'PRIVATE_REMINDER', messageId: 'REMINDER_SAFE_ID', signal: new AbortController().signal });
    return { status: 'sent' };
  } }, secretaryOutbox: { async deliverNext(send) {
    await assert.rejects(() => send({ to: `${member}@s.whatsapp.net`, text: 'SYNTHETIC_HUNG_SEND', messageId: 'TITANIUMOUT_HUNG', signal: controller.signal }));
    return { status: 'uncertain' };
  } } });
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  const sent = [];
  socket.sendMessage = async (...args) => sent.push(args);
  socket.relayMessage = async (_jid, content) => {
    assert.equal(content.extendedTextMessage.text, 'SYNTHETIC_HUNG_SEND');
    controller.abort(); return new Promise(() => {});
  };
  h.intervals[0].fn(); await flush(); await flush();
  assert.match(h.output.join('\n'), /outbox: uncertain/);
  reminderReady = true;
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0][1].text, /PRIVATE_REMINDER/);
  assert.deepEqual(h.stopped, []);
  assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC_HUNG_SEND/);
});

test('inbox replies, outbox and reminders take fair alternating turns under sustained backlogs', async t => {
  const order = [];
  const job = text => { let sequence = 0; return { async deliverNext(send) {
    await send({ to: `${member}@s.whatsapp.net`, text, messageId: `SYNTHETIC_${text}_${++sequence}`, signal: new AbortController().signal });
    return { status: text === 'OUTBOX' ? 'submitted' : 'sent' };
  } }; };
  const h = harness(t, { secretaryOutbox: job('OUTBOX'), secretaryJobs: job('REMINDER') });
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  socket.sendMessage = async (_jid, content) => order.push(content.text);
  socket.relayMessage = async (jid, message, options) => {
    assert.equal(message.extendedTextMessage.text, 'OUTBOX'); order.push('OUTBOX');
    socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: jid, id: options.messageId } });
  };
  for (let index = 0; index < 6; index++) {
    const messageId = `INBOX_${index}`;
    h.store.enqueue({ chatJid: `${member}@s.whatsapp.net`, body: { messageId, senderNumber: member, groupId: null, text: 'مرحبا', receivedAt: clock } });
    const row = h.store.db.prepare("SELECT id FROM inbox WHERE json_extract(raw_body,'$.messageId')=?").get(messageId);
    h.store.backendResult(row.id, { status: 'summary', reply: 'INBOX' });
  }
  for (let tick = 0; tick < 6; tick++) { h.intervals[0].fn(); await flush(); await flush(); }
  assert.deepEqual(order, ['INBOX', 'OUTBOX', 'INBOX', 'REMINDER', 'INBOX', 'OUTBOX']);
  assert.deepEqual(h.stopped, []);
});

test('disabled tasks pause outbox and a worker error never leaks raw errors or stops login', async t => {
  let calls = 0;
  const h = harness(t, { secretaryOutbox: { async deliverNext() { calls++; throw new Error('SYNTHETIC_SECRET_WORKER_FAILURE'); } } });
  h.config.tasksEnabled = false;
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' }); await flush();
  h.intervals[0].fn(); await flush();
  assert.equal(calls, 0);
  h.config.tasksEnabled = true;
  h.intervals[0].fn(); await flush(); await flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.stopped, []);
  assert.equal(h.runtime.status().ready, true);
  assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC_SECRET_WORKER_FAILURE/);
});

test('startup wires outbox into the same explicitly configured management database, not linked-device auth storage', () => {
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /createSecretaryOutboxJobs.*import\('\.\.\/\.\.\/\.\.\/lib\/secretary-outbox\.ts'\)/);
  assert.match(source, /const outboxSettingsPath = process\.env\.TEAM_CHAT_AUTH_CONFIG_PATH/);
  assert.match(source, /secretaryOutbox = createSecretaryOutboxJobs\(\{ db: jobsDb, config: \(\) => readOutboxConfig\(outboxSettingsPath\) \}\)/);
  assert.match(source, /control, isActiveNumber, secretaryJobs, secretaryOutbox/);
  assert.doesNotMatch(source, /authDelete|logout\(/);
});

test('unsafe group gets only one generic private refusal to verified sender, no report in group', async t => {
  const group = '120363000000000000@g.us';
  let reserved = false;
  const h = harness(t, { control: { claim: () => null, reservePrivacyAlert: () => {
    if (reserved) return false; reserved = true; return true;
  } } });
  h.config.allowedGroups.add(group);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await flush();
  socket.groupMetadata = async () => ({ id: group, size: 3, participants: [
    { id: `${botNumber}@s.whatsapp.net` }, { id: `${member}@s.whatsapp.net` }, { id: '15559999999@s.whatsapp.net' }] });
  const sent = [];
  socket.sendMessage = async (...args) => sent.push(args);
  for (const id of ['BLOCKED_ONE', 'BLOCKED_TWO']) {
    h.store.enqueue({ chatJid: group, body: { messageId: id, senderNumber: member, groupId: group, text: 'SENSITIVE_REPORT', receivedAt: clock } });
    h.intervals[0].fn(); await flush(); await flush();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], `${member}@s.whatsapp.net`);
  assert.doesNotMatch(sent[0][1].text, /SENSITIVE_REPORT|1555|120363/);
});

test('only open plus verified actual account marks runtime ready', async t => {
  const h = harness(t);
  await h.runtime.start();
  assert.equal(h.runtime.status().ready, false);
  const socket = h.sockets[0];
  assert.equal(socket.options.syncFullHistory, false);
  assert.equal(socket.options.shouldSyncHistoryMessage({}), false);
  assert.equal(socket.options.markOnlineOnConnect, false);
  socket.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
  assert.deepEqual(h.stopped, []);
});

test('wrong actual account stops without logging out/deleting auth or processing messages', async t => {
  const h = harness(t, { ownNumber: member });
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, false);
  assert.deepEqual(h.stopped, ['unexpected_or_unresolved_account']);
  assert.equal(h.sockets[0].endCalls, 1);
  assert.ok(h.store.authGet('creds', 'current'));
});

test('authorized fresh pairing emits one code and reuses saved auth on required restart', async t => {
  const h = harness(t, { paired: false, allowPairing: true });
  await h.runtime.start();
  const first = h.sockets[0];
  first.ev.emit('connection.update', { qr: 'synthetic-not-a-real-qr' });
  first.ev.emit('connection.update', { qr: 'synthetic-not-a-real-qr-again' });
  await flush();
  assert.deepEqual(first.pairCalls, [botNumber]);
  assert.equal(h.output.filter(message => message.includes('TESTCODE')).length, 1);
  first.ev.emit('creds.update', { registered: true, me: { id: `${botNumber}:5@s.whatsapp.net`, name: 'Synthetic' } });
  first.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.restartRequired } } } });
  await flush();
  assert.equal(h.timerJobs.length, 1);
  assert.equal(h.timerJobs[0].delay, 1000);
  await h.timerJobs[0].fn();
  const second = h.sockets[1];
  assert.equal(second.authState.creds.registered, true);
  second.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
  assert.deepEqual(second.pairCalls, []);
  first.ev.emit('creds.update', { me: { id: `${member}@s.whatsapp.net` } });
  await flush();
  assert.equal(h.auth.state.creds.me.id, `${botNumber}:5@s.whatsapp.net`);
});

test('missing pairing authorization and logged-out sessions stop for owner attention', async t => {
  const h = harness(t, { paired: false });
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { qr: 'synthetic' });
  await flush();
  assert.deepEqual(h.stopped, ['pairing_required']);
  assert.deepEqual(h.sockets[0].pairCalls, []);
  const h2 = harness(t);
  await h2.runtime.start();
  h2.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.loggedOut } } } });
  await flush();
  assert.deepEqual(h2.stopped, ['session_requires_owner_attention']);
  assert.equal(h2.timerJobs.length, 0);
});

test('transient reconnect schedules one retry and later old socket events are ignored', async t => {
  const h = harness(t);
  await h.runtime.start();
  const first = h.sockets[0];
  const close = { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.connectionLost } } } };
  first.ev.emit('connection.update', close);
  first.ev.emit('connection.update', close);
  await flush();
  assert.equal(h.timerJobs.length, 1);
  assert.equal(h.timerJobs[0].delay, 2000);
  await h.timerJobs[0].fn();
  first.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, false);
  h.sockets[1].ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
});

test('close arriving during asynchronous self-check cannot accidentally re-enable processing', async t => {
  const h = harness(t);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await flush();
  assert.equal(h.runtime.status().ready, false);
});

test('close diagnostics disclose only numeric status and registered boolean', async t => {
  const h = harness(t);
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: {
    error: { message: 'SYNTHETIC_SECRET_MESSAGE', data: { token: 'SYNTHETIC_SECRET_TOKEN' }, output: { statusCode: 401 } },
  } });
  await flush();
  assert.ok(h.output.includes('Titanium bridge connection closed: status=401; registered=true.'));
  assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC_SECRET|token|15551234568/);
  assert.deepEqual(h.stopped, ['session_requires_owner_attention']);
});

test('unknown close status never interpolates arbitrary error text or objects', async t => {
  for (const statusCode of [undefined, 'SYNTHETIC_SECRET_STATUS', { toString() { throw new Error('must not stringify'); } }]) {
    const h = harness(t, { paired: false, allowPairing: true });
    await h.runtime.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: {
      error: { message: 'SYNTHETIC_SECRET_MESSAGE', output: { statusCode } },
    } });
    await flush();
    assert.ok(h.output.includes('Titanium bridge connection closed: status=unknown; registered=false.'));
    assert.doesNotMatch(h.output.join('\n'), /SYNTHETIC_SECRET|must not stringify|15551234568/);
    assert.deepEqual(h.stopped, []);
    assert.equal(h.timerJobs.length, 1);
  }
});

test('new-login diagnostic is fixed text and does not imply an open connection', async t => {
  const h = harness(t, { paired: false, allowPairing: true });
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { isNewLogin: true, diagnostic: 'SYNTHETIC_SECRET_NEW_LOGIN' });
  await flush();
  assert.deepEqual(h.output, ['Titanium bridge pairing accepted; awaiting connection restart.']);
  assert.equal(h.runtime.status().ready, false);
  assert.deepEqual(h.stopped, []);
});
