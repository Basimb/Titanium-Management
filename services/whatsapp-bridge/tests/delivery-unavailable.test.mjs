import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStore } from '../src/store.mjs';
import { deliverOne } from '../src/delivery.mjs';

const NOW = 1_800_000_000_000, MEMBER = '15551234567', BOT = '15551234568';
const GROUP = '120363000000000000@g.us';
function fixture(t, group = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-unavailable-test-'));
  let store = openStore(directory), clock = NOW;
  const config = { botNumber: BOT, allowedNumbers: new Set([MEMBER]), allowedGroups: new Set(group ? [GROUP] : []),
    key: 'ab'.repeat(32), backendUrl: 'https://example.invalid/api/whatsapp/team-chat' };
  store.enqueue({ chatJid: group ? GROUP : `${MEMBER}@s.whatsapp.net`, body: {
    messageId: 'SYNTHETIC_ORIGINAL_COMMAND', senderNumber: MEMBER, groupId: group ? GROUP : null,
    text: 'سجل تحديث المهمة التجريبية', receivedAt: clock,
  } });
  const initial = store.next(clock);
  t.after(() => {
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-unavailable-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { config, initial,
    get store() { return store; }, get now() { return clock; },
    row: () => store.db.prepare('SELECT * FROM inbox WHERE id=?').get(initial.id),
    tick: () => { clock += 60_000; },
    restart: () => { store.close(); store = openStore(directory); },
    deliver: (options = {}) => deliverOne(store, store.next(clock), config, { now: () => clock, authorizeChat: async () => true, ...options }),
  };
}

function assertFeedback(f, reason) {
  const row = f.row(), result = JSON.parse(row.result);
  assert.equal(row.state, 'reply');
  assert.equal(row.backend_attempts, 5);
  assert.equal(row.reply_attempts, 0);
  assert.equal(row.reply_id, f.initial.reply_id);
  assert.equal(row.raw_body, f.initial.raw_body);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failureReason, reason);
  assert.deepEqual(Object.keys(result).sort(), ['failureReason', 'reply', 'status']);
  assert.match(result.reply, /تعذّر التأكد من نتيجة طلبك/);
  assert.match(result.reply, /راجع الموقع قبل إعادة إرساله/);
  assert.doesNotMatch(result.reply, /لم أنفذ|ما نفذت|لم أغيّر|لم يتم التنفيذ|SYNTHETIC_PRIVATE_ERROR|155512345/);
  assert.equal(result.choices, undefined);
  return row;
}

for (const failure of ['network', 429, 503]) {
  test(`exhausted ${failure} retries produce one controlled reply, preserving command body and existing reply ID`, async t => {
    const f = fixture(t), bodies = [], replies = [];
    const fetcher = async (_url, options) => {
      bodies.push(options.body);
      if (failure === 'network') throw Error('SYNTHETIC_PRIVATE_ERROR');
      return new Response('', { status: failure });
    };
    for (let i = 0; i < 5; i++) { await f.deliver({ fetcher }); f.tick(); }
    assert.equal(bodies.length, 5);
    assert.equal(new Set(bodies).size, 1);
    assertFeedback(f, failure === 'network' ? 'backend_network_exhausted' : `backend_${failure}_exhausted`);
    await f.deliver({ fetcher: async () => assert.fail('must not retry command after fallback'),
      sendReply: async (...args) => replies.push(args) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0][0], f.initial.chat_jid);
    assert.equal(replies[0][2], f.initial.reply_id);
    assert.equal(f.row().state, 'done');
    assert.equal(f.store.next(f.now), undefined);
    f.restart();
    assert.equal(f.store.next(f.now), undefined);
  });
}

test('last attempt timing out after possible server application never claims no change or issues another command', async t => {
  const f = fixture(t);
  f.store.db.prepare('UPDATE inbox SET backend_attempts=4 WHERE id=?').run(f.initial.id);
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let possibleApplication = 0;
  await f.deliver({ fetcher: async (_url, options) => {
    possibleApplication++;
    const aborted = new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    controller.abort(new DOMException('Synthetic timeout', 'TimeoutError'));
    return aborted;
  } });
  assertFeedback(f, 'backend_network_exhausted');
  let reply;
  await f.deliver({ fetcher: async () => assert.fail('ambiguous write must not be replayed'), sendReply: async (_jid, text) => { reply = text; } });
  assert.equal(possibleApplication, 1);
  assert.match(reply, /تعذّر التأكد/);
  assert.equal(f.row().backend_attempts, 5);
});

test('restart converts only an active exhausted backend row and keeps only static failure evidence', async t => {
  for (const [lastReason, expected] of [['backend_network', 'backend_network_exhausted'], ['backend_429', 'backend_429_exhausted'],
    ['backend_503', 'backend_503_exhausted'], ['SYNTHETIC_PRIVATE_ERROR', 'backend_retry_exhausted']]) {
    const f = fixture(t);
    f.store.db.prepare('UPDATE inbox SET backend_attempts=5,error_code=? WHERE id=?').run(lastReason, f.initial.id);
    f.restart();
    await f.deliver({ fetcher: async () => assert.fail('already exhausted'), sendReply: async () => assert.fail('reply is separately queued') });
    assertFeedback(f, expected);
    assert.doesNotMatch(f.row().result, /SYNTHETIC_PRIVATE_ERROR/);
  }
});

test('old failed rows remain terminal and are never automatically revived', async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE inbox SET state='failed',backend_attempts=5,error_code='backend_retry_exhausted' WHERE id=?").run(f.initial.id);
  f.restart();
  assert.equal(f.store.next(f.now), undefined);
  await deliverOne(f.store, f.row(), f.config, { now: () => f.now, authorizeChat: async () => true,
    fetcher: async () => assert.fail('old failed command'), sendReply: async () => assert.fail('old failed feedback') });
  assert.equal(f.row().state, 'failed');
  assert.equal(f.row().result, null);
});

test('feedback transport retries reuse the same reply ID and never rerun the task command', async t => {
  const f = fixture(t), sends = [];
  f.store.db.prepare('UPDATE inbox SET backend_attempts=5 WHERE id=?').run(f.initial.id);
  await f.deliver();
  const sendReply = async (jid, text, id, _body, result) => {
    sends.push({ jid, text, id, result });
    if (sends.length < 3) throw Error('SYNTHETIC_PRIVATE_ERROR');
  };
  for (let i = 0; i < 3; i++) {
    await f.deliver({ sendReply, fetcher: async () => assert.fail('feedback must not rerun command') });
    f.tick();
    if (i === 0) f.restart();
  }
  assert.equal(sends.length, 3);
  assert.equal(new Set(sends.map(item => item.id)).size, 1);
  assert.equal(sends[0].id, f.initial.reply_id);
  assert.equal(new Set(sends.map(item => item.text)).size, 1);
  assert.equal(sends[0].result.failureReason, 'backend_retry_exhausted');
  assert.equal(f.row().state, 'done');
  assert.equal(f.row().backend_attempts, 5);
});

test('revoked sender is denied before fallback construction and again before fallback delivery', async t => {
  for (const phase of ['before', 'after']) {
    const f = fixture(t);
    f.store.db.prepare('UPDATE inbox SET backend_attempts=5 WHERE id=?').run(f.initial.id);
    if (phase === 'after') await f.deliver();
    f.config.allowedNumbers.clear();
    await f.deliver({ sendReply: async () => assert.fail('revoked recipient'), fetcher: async () => assert.fail('revoked sender') });
    assert.equal(f.row().state, 'failed');
    assert.equal(f.row().error_code, 'authorization_removed');
  }
  const f = fixture(t);
  f.store.db.prepare('UPDATE inbox SET backend_attempts=5 WHERE id=?').run(f.initial.id);
  await f.deliver({ authorizeChat: async () => false });
  assert.equal(f.row().error_code, 'privacy_check_failed');
  assert.equal(f.row().result, null);
});

test('group feedback still requires current allowlist and fresh privacy checks at both phases', async t => {
  const blocked = fixture(t, true);
  blocked.store.db.prepare('UPDATE inbox SET backend_attempts=5 WHERE id=?').run(blocked.initial.id);
  await blocked.deliver({ authorizeChat: undefined, sendReply: async () => assert.fail('missing group policy') });
  assert.equal(blocked.row().error_code, 'privacy_check_failed');
  const f = fixture(t, true);
  f.store.db.prepare('UPDATE inbox SET backend_attempts=5 WHERE id=?').run(f.initial.id);
  let allowed = true, checks = 0;
  const authorizeChat = async () => { checks++; return allowed; };
  await f.deliver({ authorizeChat });
  assertFeedback(f, 'backend_retry_exhausted');
  allowed = false;
  await f.deliver({ authorizeChat, sendReply: async () => assert.fail('new group outsider must block feedback') });
  assert.equal(checks, 2);
  assert.equal(f.row().error_code, 'privacy_check_failed');
});

test('nonretriable HTTP failures preserve existing terminal behavior rather than silently broadening retries', async t => {
  for (const status of [400, 401, 403, 500]) {
    const f = fixture(t);
    await f.deliver({ fetcher: async () => new Response('', { status }), sendReply: async () => assert.fail('unexpected fallback scope') });
    assert.equal(f.row().state, 'failed');
    assert.equal(f.row().error_code, `backend_http_${status}`);
    assert.equal(f.row().result, null);
  }
});

test('backend respects Retry-After and preserves the original request',async t=>{
 const f=fixture(t);await f.deliver({fetcher:async()=>new Response('',{status:503,headers:{'retry-after':'90'}})});
 const row=f.row();assert.equal(row.next_at,f.now+90000);assert.equal(row.raw_body,f.initial.raw_body);assert.equal(row.backend_attempts,1);
 assert.equal(f.store.next(f.now+89000),undefined);
});

