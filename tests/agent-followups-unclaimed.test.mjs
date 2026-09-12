// Basim: "فيه مهام مش مستلمه واضحه عندك بدنا نعالج المشكله هاي... حط النظام
// انه يسلمها للموظف ويضل يكرر عليه كل ساعه لحد ما يستلمها حتى لو خارج اوقات
// الدوام و لو ما كان الها موظف رجعلي اياها" -- covers the two halves of that
// request: an "open" task with a suggested owner keeps nagging that owner
// EVERY HOUR, even outside the 9-18 work-hours window the rest of
// planFollowups is gated by; and an "open" task with NO suggested owner at
// all escalates straight back to Basim, same always-on hourly cadence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateManagementActions } from '../lib/management-actions.ts';
import { planFollowups } from '../lib/agent-followups.ts';

function schema(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
`);
}
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  // Deliberately NOT migrating here -- migrateManagementActions (via
  // migrateAgentSchema) ALTER TABLEs extra columns onto `tasks` (watcher,
  // expected_at, blocker, last_update_at), so running it before a test's own
  // positional `INSERT INTO tasks VALUES(...15 values...)` would make that
  // insert mismatch the now-19-column table. planFollowups() itself already
  // calls migrateManagementActions on every invocation, so it's applied
  // lazily, after each test has inserted its rows against the plain schema.
  schema(db);
  const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'member', number: '962770000000' }], groupId: '123@g.us' };
  return { db, config };
}
// 2026-09-10 03:00 Amman (+03:00) -- well outside the default 9-18 work window.
const NIGHT = Date.UTC(2026, 8, 10, 0, 0);

test('an open task suggested to an employee nags that employee hourly, including outside work hours', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  const mine = plans.filter(p => p.kind === 'unclaimed_task' && p.targetUser === 'member' && p.entityId === 't1');
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /خالد/); assert.match(mine[0].text, /مهمة خالد/);
});

test('the hourly nag never re-fires for the same task inside the same hour window', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  migrateManagementActions(db); // creates agent_followups before this test inserts into it directly
  db.prepare("INSERT INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES ('x','unclaimed_task','member','t1',?,'sent')").run(NIGHT - 10 * 60_000);
  const plans = planFollowups(db, config, NIGHT);
  assert.equal(plans.filter(p => p.kind === 'unclaimed_task' && p.entityId === 't1').length, 0, 'sent 10 minutes ago -- too soon to repeat');
});

test('the hourly nag fires again once an hour has actually passed', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  migrateManagementActions(db);
  db.prepare("INSERT INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES ('x','unclaimed_task','member','t1',?,'sent')").run(NIGHT - 61 * 60_000);
  const plans = planFollowups(db, config, NIGHT);
  assert.equal(plans.filter(p => p.kind === 'unclaimed_task' && p.entityId === 't1').length, 1);
});

test('an open task with no suggested owner at all escalates to Basim hourly, including outside work hours', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t2','مهمة بلا موظف','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  const toBasim = plans.filter(p => p.kind === 'unowned_task' && p.targetUser === 'basem' && p.entityId === 't2');
  assert.equal(toBasim.length, 1);
  assert.match(toBasim[0].text, /باسم/); assert.match(toBasim[0].text, /مهمة بلا موظف/);
  assert.equal(plans.filter(p => p.kind === 'unclaimed_task' && p.entityId === 't2').length, 0, 'no suggested owner -- never the employee-facing nag');
});

// 2026-09-12, Basim: "وهاي التنبهات قلتلك تيجي تصويت مش هيك نصوص" -- this
// nudge must carry a real tappable poll, not just plain text (see
// unownedTaskPoll in agent-followups.ts and its resolution,
// parseUnownedTaskPollChoice, in secretary-service.ts).
test('the unowned-task escalation to Basim carries a real tappable poll -- a colleague-name option per active employee plus a self-claim option', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t2','مهمة بلا موظف','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  const toBasim = plans.find(p => p.kind === 'unowned_task' && p.targetUser === 'basem' && p.entityId === 't2');
  assert.ok(toBasim.choices, 'must attach a tappable poll, not bare text');
  assert.equal(toBasim.choices.id, 'UNOWNQt2');
  assert.deepEqual(toBasim.choices.options.map(o => o.label), ['خالد', '🙋 تولاها بنفسك']);
  assert.equal(toBasim.choices.options[0].id, 'UNOWNt2_member');
  assert.equal(toBasim.choices.options[1].id, 'UNOWNt2_SELF');
});

// 2026-09-12, Basim (after previewing the exact merged text and approving
// it -- "طيب كويس طبق"): the "come claim this task" nudge to the suggested
// owner now carries the same five-command legend (🧭 أوامر المهام السريعة)
// inline, appended once at the end -- never a separate follow-up message.
test('the unclaimed-task nudge to the suggested owner carries the five-command legend inline', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  const mine = plans.find(p => p.kind === 'unclaimed_task' && p.targetUser === 'member' && p.entityId === 't1');
  assert.match(mine.text, /🧭 أوامر المهام السريعة/);
  assert.match(mine.text, /5️⃣ 🔴 انهاء المهمة/);
});

// 2026-09-12, Basim tapped an older "حددلها موظف مسؤول" poll bubble for an
// unowned task -- WhatsApp showed it as a registered vote (green check) but
// the server rejected it as stale, because a later resend of this same
// hourly nudge had already superseded that bubble server-side while
// WhatsApp's own UI never marks the old bubble as expired ("شو هذا ازهقت
// اعدل اخطاء ياخي"). The unowned-task nudge now carries the same explicit
// warning the unclaimed-task nudge already had, telling Basim only the poll
// attached to THIS message is live.
test('the unowned-task escalation to Basim warns that only the poll on this message is live (mirrors the unclaimed-task nudge)', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t2','مهمة بلا موظف','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  const toBasim = plans.find(p => p.kind === 'unowned_task' && p.targetUser === 'basem' && p.entityId === 't2');
  assert.match(toBasim.text, /أقدم من هذه الرسالة لنفس المهمة، هو منتهي الصلاحية/);
});

test('a task already claimed (owner set) triggers neither the unclaimed nor the unowned nudge', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t3','مهمة مستلمة','','yellow','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL)`);
  const plans = planFollowups(db, config, NIGHT);
  assert.equal(plans.filter(p => p.entityId === 't3').length, 0);
});

test('a pending transfer/decline approval on the task suppresses the employee-facing nag (the ball is in Basim\'s court now)', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t1','مهمة خالد','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL)`);
  // Run the migration now (before planFollowups would) so the real
  // `approvals` table (created by migrateAgentSchema) exists to insert into.
  // Safe to insert into `tasks` beforehand -- the ALTER TABLEs this adds only
  // ever append nullable columns.
  migrateManagementActions(db);
  db.exec(`INSERT INTO approvals (id,type,status,requested_by,requested_by_name,entity_type,entity_id,summary,created_at) VALUES ('a1','task_transfer','pending','member','خالد','task','t1','طلب تحويل',1)`);
  const plans = planFollowups(db, config, NIGHT);
  assert.equal(plans.filter(p => p.kind === 'unclaimed_task' && p.entityId === 't1').length, 0);
});

test('an archived task is excluded from both the unclaimed and the unowned nudge', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES('t4','مهمة مؤرشفة','','yellow','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,999,'basem')`);
  const plans = planFollowups(db, config, NIGHT);
  assert.equal(plans.filter(p => p.entityId === 't4').length, 0);
});
