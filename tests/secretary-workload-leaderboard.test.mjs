// Basim: "لما أسأله مين أكثر موظف عنده مهام، يحلل ويعطيني إنه أيمن عنده 17
// مهمة" -- counting must never be left to the model (same reason every other
// list in secretary-service.ts is server-computed), so "مين أكثر موظف عنده
// مهام؟" is recognized directly from the text (see workloadQuery in
// handleSecretaryEvent) and answered from a real, freshly computed count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1),('mgr','أيمن','manager',1,NULL,1,1);
`);
  const insert = db.prepare("INSERT INTO tasks(id,title,details,priority,status,owner,suggested_owner,created_at,updated_at) VALUES(?,?,'','red',?,?,?,1,1)");
  for (let n = 1; n <= 5; n++) insert.run(`aiman-${n}`, `مهمة أيمن ${n}`, 'progress', 'أيمن', 'أيمن'); // busiest
  for (let n = 1; n <= 2; n++) insert.run(`khaled-${n}`, `مهمة خالد ${n}`, 'progress', 'خالد', 'خالد');
  insert.run('shadi-done', 'مهمة شادي المنتهية', 'completed', 'شادي', 'شادي'); // completed -- never counted
  insert.run('shadi-archived', 'مهمة شادي المؤرشفة', 'progress', 'شادي', 'شادي');
  db.exec("UPDATE tasks SET archived_at=1 WHERE id='shadi-archived'"); // archived -- never counted
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }, { userId: 'mgr', number: '12025550104' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550103', groupId: null, text: 'مين أكثر موظف عنده مهام؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (extra = {}) => handleSecretaryEvent(db, event(extra), config, { infer: async () => { throw Error('a recognized workload question must never reach the model'); }, now: () => now });
  return { db, run };
}

test('Basim asking who has the most tasks gets a real, server-counted answer naming the busiest employee', async t => {
  const f = fixture(t);
  const r = await f.run();
  assert.equal(r.status, 'summary');
  assert.match(r.reply, /أيمن/);
  assert.match(r.reply, /5/, 'the exact live count, not a guess');
  assert.match(r.reply, /خالد/, 'the rest of the team is shown too, for context');
  assert.doesNotMatch(r.reply, /شادي/, 'شادي has zero open tasks (one completed, one archived) so drops off the board');
});
test('a manager can ask the same question and gets the same real answer', async t => {
  const f = fixture(t);
  const r = await f.run({ senderNumber: '12025550104', text: 'مين أكثر موظف عنده مهام؟' });
  assert.match(r.reply, /أيمن/);
  assert.match(r.reply, /5/);
});
test('phrasing variants of the same question are all recognized without hitting the model', async t => {
  const f = fixture(t);
  for (const text of ['مين اكثر موظف عنده مهام', 'مين عنده أكثر مهام', 'أكثر واحد مشغول مين', 'مين أكثر حدا عنده شغل']) {
    const r = await f.run({ text, messageId: `V-${text}` });
    assert.match(r.reply, /أيمن/, `phrasing: ${text}`);
  }
});
test('a plain employee asking the same question falls through to the model instead of a wrong self-only answer', async t => {
  const f = fixture(t);
  // خالد's own management snapshot only ever contains his own tasks (see
  // canViewManagementTask), so a leaderboard computed from it would silently
  // be wrong -- workloadQuery is restricted to admin/manager, so an
  // employee's message is left for the normal model-driven pipeline, whose
  // stub here throws to prove it was actually reached.
  await assert.rejects(f.run({ senderNumber: '12025550101', text: 'مين أكثر موظف عنده مهام؟' }));
});
test('with nothing assigned to anyone, the leaderboard says so instead of naming someone with zero tasks', async t => {
  const f = fixture(t);
  f.db.exec("UPDATE tasks SET status='completed'");
  const r = await f.run();
  assert.match(r.reply, /ما في مهام مفتوحة موزّعة/);
});
