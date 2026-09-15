// Basim (2026-09-15): "لسه فيه رسايل تذكيريه للكل والتعليقات مش ظاهره فيها" --
// the earlier pass put the newest two notes on every on-demand listing and on
// the twice-daily reminder, but the reactive nudges (and the overdue digest
// the whole group sees) still named a task with no sign of what had been
// logged on it. The silent_task nudge was the worst of them: a message whose
// entire point is "I haven't heard anything about this" while notes sat on
// the task unread. Same two-newest rule everywhere else uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { planFollowups } from '../lib/agent-followups.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);`);
  const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'member', number: '962770000000' }], groupId: '123@g.us' };
  return { db, config };
}
// 2026-09-10, 11:00 Amman (+03:00) -- inside the 9-18 work window.
const DAY_AT = Date.UTC(2026, 8, 10, 8, 0);
const NIGHT = Date.UTC(2026, 8, 10, 0, 0);
const notes = (db, taskId) => db.exec(`INSERT INTO comments (task_id,author,body,created_at) VALUES
  ('${taskId}','أيمن','أقدم ملاحظة ما لازم تظهر',100),
  ('${taskId}','شادي','جهزت الكشف وبعتته',200),
  ('${taskId}','خالد','حكيت مع النقابة اليوم',300)`);
const twoNewest = (text, where) => {
  assert.match(text, /خالد: حكيت مع النقابة اليوم/, `${where}: newest note`);
  assert.match(text, /شادي: جهزت الكشف وبعتته/, `${where}: the one before it`);
  assert.doesNotMatch(text, /أقدم ملاحظة/, `${where}: never a third`);
};

test('the overdue nudge carries the newest two notes', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مزاولات الصيادلة','','red','progress','خالد','خالد',1,'2026-09-01',NULL,NULL,1,1,NULL,NULL)`);
  notes(db, 't1');
  const plan = planFollowups(db, config, DAY_AT).find(p => p.kind === 'overdue_task');
  assert.ok(plan, 'the overdue nudge still goes out');
  twoNewest(plan.text, 'overdue nudge');
});

test('the "no update in 3 days" nudge shows what was actually logged', t => {
  const { db, config } = fixture(t);
  const old = DAY_AT - 10 * 24 * 3600_000;
  db.exec(`INSERT INTO tasks VALUES('t1','السجل التجاري','','red','progress','خالد','خالد',${old},NULL,NULL,NULL,${old},${old},NULL,NULL)`);
  notes(db, 't1');
  const plan = planFollowups(db, config, DAY_AT).find(p => p.kind === 'silent_task');
  assert.ok(plan, 'the silent nudge still goes out');
  twoNewest(plan.text, 'silent nudge');
});

test('the unclaimed-task nag carries the notes too', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  notes(db, 't1');
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unclaimed_task');
  assert.ok(plan);
  twoNewest(plan.text, 'unclaimed nag');
});

test('the unowned-task escalation to Basim carries the notes', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة بلا مسؤول','','yellow','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  notes(db, 't1');
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unowned_task');
  assert.ok(plan);
  twoNewest(plan.text, 'unowned escalation');
});

test('the overdue digest the whole group sees carries the notes', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مزاولات الصيادلة','','red','progress','خالد','خالد',1,'2026-09-01',NULL,NULL,1,1,NULL,NULL)`);
  notes(db, 't1');
  const plan = planFollowups(db, config, DAY_AT).find(p => p.kind === 'daily_digest' && p.targetUser === 'group');
  assert.ok(plan, 'the group digest still goes out');
  twoNewest(plan.text, 'group digest');
});

test('a task with no notes gains no note lines in any of them', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مزاولات الصيادلة','','red','progress','خالد','خالد',1,'2026-09-01',NULL,NULL,1,1,NULL,NULL)`);
  for (const plan of planFollowups(db, config, DAY_AT)) assert.doesNotMatch(plan.text, /↳/, `${plan.kind} must stay clean`);
});
