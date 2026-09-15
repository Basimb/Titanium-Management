// The other half of the reminder fan-out fix (see
// tests/secretary-reminder-fanout.test.mjs for the sending side): a tap on
// the one picker poll a person now receives has to land them exactly where
// the old five-messages-five-polls shape did -- on that task's own card with
// its own action poll -- and it has to resolve in code, never by handing the
// tap's label to the model (Basim: "مشان نتجاوز مشكله الذكاء").
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const OPEN = '11111111-1111-4111-8111-111111111111';
const PROGRESS = '22222222-2222-4222-8222-222222222222';
// Not every real task id is a UUID: tasks that predate randomUUID() kept
// short ids like "dl-3" (scripts/migrate-drop-projects.sql), and a stricter
// id pattern is exactly what silently dropped real taps on them once before.
const LEGACY = 'dl-3';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO tasks VALUES
      ('${OPEN}','مهمة مقترحة','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL),
      ('${PROGRESS}','لوحة','تفاصيل','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL),
      ('${LEGACY}','مهمة قديمة','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'مهمة مقترحة', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  let asked = 0;
  const run = (extra = {}) => handleSecretaryEvent(db, event(extra), config,
    { infer: async () => { asked += 1; return emptySecretaryIntent('summary'); }, now: () => now });
  return { db, config, run, now, modelCalls: () => asked };
}
const tap = (questionId, optionId) => ({ choice: { questionId, optionId } });

test('tapping a task in the picker answers with that task\'s card and its own action poll', async t => {
  const f = fixture(t);
  const r = await f.run(tap('TPKQ', `TPK${PROGRESS}`));
  assert.equal(r.status, 'summary');
  assert.equal(r.taskId, PROGRESS);
  assert.match(r.reply, /لوحة/);
  assert.equal(r.choices.id, `TSKQ${PROGRESS}`);
  assert.deepEqual(r.choices.options.map(o => o.id),
    [`TSK${PROGRESS}FINISH`, `TSK${PROGRESS}NOTE`, `TSK${PROGRESS}TRANSFER`, `TSK${PROGRESS}EDIT`, `TSK${PROGRESS}EXTEND`]);
  assert.equal(f.modelCalls(), 0, 'a tap must resolve in code, never by asking the model');
});

test('a picked task that is still unclaimed offers the claim poll', async t => {
  const f = fixture(t);
  const r = await f.run(tap('TPKQ', `TPK${OPEN}`));
  assert.equal(r.taskId, OPEN);
  assert.deepEqual(r.choices.options.map(o => o.id), [`TSK${OPEN}CLAIM`, `TSK${OPEN}TRANSFER`, `TSK${OPEN}EDIT`]);
});

test('a legacy short task id resolves too -- a stricter id pattern once dropped these silently', async t => {
  const f = fixture(t);
  const r = await f.run(tap('TPKQ', `TPK${LEGACY}`));
  assert.equal(r.taskId, LEGACY);
  assert.equal(r.choices.id, `TSKQ${LEGACY}`);
  assert.equal(f.modelCalls(), 0);
});

test('a picked task that no longer exists says so instead of falling through to the model', async t => {
  const f = fixture(t);
  const r = await f.run(tap('TPKQ', 'TPK99999999-9999-4999-8999-999999999999'));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عادت متاحة/);
  assert.equal(f.modelCalls(), 0);
});

test('a malformed picker option is left to the ordinary pipeline, never parsed into a task id', async t => {
  const f = fixture(t);
  const r = await f.run(tap('TPKQ', 'TPK../../etc/passwd'));
  // An option id this branch refuses is not quietly handed onward either --
  // an unrecognised choice is denied upstream, so a crafted label can never
  // reach the model as if it were something the person typed.
  assert.deepEqual(r, { status: 'denied', reply: '' });
  assert.equal(f.modelCalls(), 0);
});

test('a picker tap inside the group chat never resolves there -- polls are private-chat only', async t => {
  const f = fixture(t);
  const r = await f.run({ ...tap('TPKQ', `TPK${PROGRESS}`), groupId: '12345@g.us' });
  assert.notEqual(r.taskId, PROGRESS);
});
