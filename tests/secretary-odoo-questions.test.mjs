// The wiring half of the live-questions feature: a recognised question must be
// answered from Odoo BEFORE the model ever sees the message, an unrecognised
// one must reach the ordinary secretary untouched, and the pharmacy system
// being down must say so rather than swallow the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function fixture(t, { askOdoo } = {}) {
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
  }, config, { infer: async () => { modelCalls += 1; return emptySecretaryIntent('chat', 'رد عادي'); }, now: () => now, ...(askOdoo ? { askOdoo } : {}) });
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
