// The wiring half of the live-questions feature: a recognised question must be
// answered from Odoo BEFORE the model ever sees the message, an unrecognised
// one must reach the ordinary secretary untouched, and the pharmacy system
// being down must say so rather than swallow the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function fixture(t, { askOdoo, classifyOdoo } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0, modelCalls = 0; const now = 1788580000000;
  const run = (extra = {}) => handleSecretaryEvent(db, {
    messageId: `E-${++count}`, senderNumber: '12025550101', groupId: null, text: 'x', receivedAt: now, responseMessageId: `R-${count}`, ...extra,
  }, config, { infer: async () => { modelCalls += 1; return emptySecretaryIntent('chat', 'رد عادي'); }, now: () => now, ...(askOdoo ? { askOdoo } : {}), ...(classifyOdoo ? { classifyOdoo } : {}) });
  return { db, run, modelCalls: () => modelCalls };
}

test('a recognised question is answered from Odoo, and the model is never asked', async t => {
  const seen = [];
  const f = fixture(t, { askOdoo: async (match) => { seen.push(match); return '📊 مبيعات اليوم: 1,000.00'; } });
  const r = await f.run({ text: 'شو مبيعات اليوم؟' });
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(seen, [{ kind: 'sales_today', branch: null }]);
  assert.equal(r.status, 'summary');
  assert.match(r.reply, /1,000\.00/);
});

test('the branch named in the question is carried through', async t => {
  const seen = [];
  const f = fixture(t, { askOdoo: async (match) => { seen.push(match.branch); return 'ok'; } });
  await f.run({ text: 'مبيعات صافوط امبارح' });
  assert.deepEqual(seen, ['SAFOT']);
});

test('an ordinary message is untouched and still reaches the secretary', async t => {
  const f = fixture(t, { askOdoo: async () => assert.fail('not a pharmacy question') });
  // Deliberately not a task command either -- those have their own
  // deterministic handlers, and this test is about the ordinary model path.
  const r = await f.run({ text: 'في اجتماع بكرة الساعة عشرة' });
  assert.equal(f.modelCalls(), 1);
  assert.equal(r.reply, 'رد عادي');
});

test('with no pharmacy system configured, the same question is just a message', async t => {
  const f = fixture(t); // no askOdoo
  await f.run({ text: 'شو مبيعات اليوم؟' });
  assert.equal(f.modelCalls(), 1, 'falls through to the ordinary secretary');
});

test('a poll tap is never treated as a question, however its label reads', async t => {
  const f = fixture(t, { askOdoo: async () => assert.fail('a tap is not a question') });
  await f.run({ text: 'مبيعات', choice: { questionId: 'TPKQ', optionId: 'TPKt1' } });
});

test('the pharmacy system being down says so, and does not lose the message', async t => {
  const f = fixture(t, { askOdoo: async () => { throw new Error('odoo_unreachable'); } });
  const r = await f.run({ text: 'شو ناقص من المخزون' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما قدرت أوصل لنظام الصيدلية/);
  assert.equal(f.modelCalls(), 0);
});

test('asking the same thing twice replays the stored answer instead of hitting Odoo again', async t => {
  let calls = 0;
  const f = fixture(t, { askOdoo: async () => { calls += 1; return 'رقم'; } });
  const first = await f.run({ messageId: 'SAME', responseMessageId: 'R', text: 'شو مبيعات اليوم؟' });
  const again = await f.run({ messageId: 'SAME', responseMessageId: 'R', text: 'شو مبيعات اليوم؟' });
  assert.equal(calls, 1);
  assert.equal(first.reply, again.reply);
});

// Basim (2026-09-17): "بدي يصير الذكاء يربط الاسئله انها مبيعات وهيك". The
// router reads the wording when the written-out patterns do not recognise it.
// It is asked LAST and for routing only -- these tests pin both halves of that.
test('a question the patterns miss is routed by the model, and answered from Odoo', async t => {
  const routed = [];
  const asked = [];
  const f = fixture(t, {
    askOdoo: async match => { asked.push(match); return '📊 الرقم من النظام'; },
    classifyOdoo: async text => { routed.push(text); return { kind: 'sales_month', branch: 'DABOQ' }; },
  });
  const r = await f.run({ text: 'قديش صار عنا بدابوق من أول الشهر؟' });
  assert.deepEqual(routed, ['قديش صار عنا بدابوق من أول الشهر؟']);
  assert.deepEqual(asked, [{ kind: 'sales_month', branch: 'DABOQ' }]);
  assert.equal(r.status, 'summary');
  assert.equal(f.modelCalls(), 0, 'the ordinary planner must not also run');
});

test('a wording the patterns already know never reaches the router', async t => {
  let routerCalls = 0;
  const f = fixture(t, {
    askOdoo: async () => 'ok',
    classifyOdoo: async () => { routerCalls += 1; return null; },
  });
  await f.run({ text: 'شو مبيعات اليوم؟' });
  assert.equal(routerCalls, 0, 'the free path answers first');
});

test('an ordinary instruction is not a question, so it never costs a routing call', async t => {
  let routerCalls = 0;
  const f = fixture(t, {
    askOdoo: async () => assert.fail('must not answer from Odoo'),
    classifyOdoo: async () => { routerCalls += 1; return null; },
  });
  const r = await f.run({ text: 'ذكّر خالد بالطلبية' });
  assert.equal(routerCalls, 0);
  assert.equal(f.modelCalls(), 1, 'it goes to the ordinary secretary instead');
  assert.equal(r.reply, 'رد عادي');
});

test('a question the router declines falls through to the ordinary secretary', async t => {
  const f = fixture(t, {
    askOdoo: async () => assert.fail('nothing to answer'),
    classifyOdoo: async () => null,
  });
  const r = await f.run({ text: 'مين مسؤول عن الطلبية؟' });
  assert.equal(f.modelCalls(), 1);
  assert.equal(r.reply, 'رد عادي');
});

test('a router that fails is not an error the person ever sees', async t => {
  const f = fixture(t, {
    askOdoo: async () => assert.fail('nothing to answer'),
    classifyOdoo: async () => { throw new Error('provider down'); },
  });
  await assert.rejects(f.run({ text: 'قديش صار عنا اليوم؟' }));
});
