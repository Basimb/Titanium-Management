// Basim (2026-09-15): "اليوم اعطاني تصويتات مشطبوكه ببعض وهذا خلل صح؟" -- and
// it was. The live bridge's choice_polls table showed 16 separate polls
// created in the SAME MINUTE at 09:00 (five to أيمن alone), because the
// unclaimed nudge and the overdue/silent nudge were both written one whole
// message + one live poll PER TASK. Everything below pins the collapsed
// shape: one message per PERSON, listing their tasks numbered, with ONE
// picker poll whose options are those tasks (see taskPickerPoll in
// lib/agent-followups.ts, and parseTaskPickerChoice in
// lib/secretary-service.ts for what a tap on one resolves to).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateManagementActions } from '../lib/management-actions.ts';
import { planFollowups } from '../lib/agent-followups.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  // Same deliberate "schema first, migrate later" ordering the other
  // followups fixtures use -- migrateManagementActions ALTERs extra columns
  // onto `tasks`, so a positional INSERT has to run before it does.
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
const open = (id, title) => `INSERT INTO tasks VALUES('${id}','${title}','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL);`;
// 03:00 Amman -- outside the 9-18 window, so only the always-on unclaimed nudge plans.
const NIGHT = Date.UTC(2026, 8, 10, 0, 0);
// 10:00 Amman -- inside the window, where the overdue/silent nudge also plans.
const DAY = Date.UTC(2026, 8, 10, 7, 0);

test('five unclaimed tasks for one person produce ONE message and ONE poll, not five of each', t => {
  const { db, config } = fixture(t);
  db.exec([1, 2, 3, 4, 5].map(n => open(`t${n}`, `مهمة ${n}`)).join(''));
  const plans = planFollowups(db, config, NIGHT).filter(plan => plan.kind === 'unclaimed_task');
  assert.equal(plans.length, 1, 'one nudge per person, whatever their task count');
  assert.equal(plans[0].targetUser, 'member');
  assert.equal(plans[0].entityId, null, 'the dedup key is the person now, never a single task');
  for (const n of [1, 2, 3, 4, 5]) assert.match(plans[0].text, new RegExp(`مهمة ${n}`), `task ${n} still named in the one message`);
  assert.equal(plans[0].choices.id, 'TPKQ');
  assert.deepEqual(plans[0].choices.options.map(o => o.id), ['TPKt1', 'TPKt2', 'TPKt3', 'TPKt4', 'TPKt5']);
});

test('the picker poll numbers its labels so two tasks sharing a title stay distinguishable', t => {
  const { db, config } = fixture(t);
  db.exec(open('t1', 'تجديد رخصة') + open('t2', 'تجديد رخصة'));
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unclaimed_task');
  const labels = plan.choices.options.map(o => o.label);
  assert.deepEqual(labels, ['1. تجديد رخصة', '2. تجديد رخصة']);
  // The bridge rejects a poll whose labels are not unique (a vote is matched
  // by hashing the label, see normalizePollChoices/acceptVote) -- without the
  // numbering these two would have collided and the whole poll been dropped.
  assert.equal(new Set(labels).size, labels.length);
});

test('the picker is capped at ten options -- the bridge refuses more than twelve', t => {
  const { db, config } = fixture(t);
  db.exec(Array.from({ length: 14 }, (_, i) => open(`t${i}`, `مهمة ${i}`)).join(''));
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unclaimed_task');
  assert.equal(plan.choices.options.length, 10);
});

test('a single unclaimed task keeps its own task-action poll, not a one-option picker', t => {
  const { db, config } = fixture(t);
  db.exec(open('t1', 'مهمة وحيدة'));
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unclaimed_task');
  assert.equal(plan.choices.id, 'TSKQt1', 'one task needs no picker -- go straight to its actions');
  assert.deepEqual(plan.choices.options.map(o => o.id), ['TSKt1CLAIM', 'TSKt1TRANSFER', 'TSKt1EDIT']);
});

test('reminder polls live a full 24h -- the ceiling the bridge enforces, not the old hour', t => {
  const { db, config } = fixture(t);
  db.exec(open('t1', 'مهمة') + open('t2', 'مهمة ثانية'));
  const plan = planFollowups(db, config, NIGHT).find(p => p.kind === 'unclaimed_task');
  // An hour was the actual mechanism behind 61 silently rejected taps in one
  // day: WhatsApp keeps the bubble tappable long after the poll is dead.
  assert.equal(plan.choices.expiresAt - NIGHT, 24 * 60 * 60_000);
});

test('several overdue tasks for one person collapse into one nudge with one picker too', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES
    ('o1','متأخرة أولى','','red','progress','خالد','خالد',1,'2026-09-01',NULL,NULL,1,1,NULL,NULL),
    ('o2','متأخرة ثانية','','red','progress','خالد','خالد',1,'2026-09-02',NULL,NULL,1,1,NULL,NULL),
    ('o3','متأخرة ثالثة','','red','progress','خالد','خالد',1,'2026-09-03',NULL,NULL,1,1,NULL,NULL);`);
  const plans = planFollowups(db, config, DAY).filter(plan => plan.kind === 'overdue_task');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].entityId, null);
  assert.deepEqual(plans[0].choices.options.map(o => o.id), ['TPKo1', 'TPKo2', 'TPKo3']);
  for (const title of ['متأخرة أولى', 'متأخرة ثانية', 'متأخرة ثالثة']) assert.match(plans[0].text, new RegExp(title));
});

test('the per-person overdue nudge repeats at most once a day, however often the planner runs', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES
    ('o1','متأخرة أولى','','red','progress','خالد','خالد',1,'2026-09-01',NULL,NULL,1,1,NULL,NULL),
    ('o2','متأخرة ثانية','','red','progress','خالد','خالد',1,'2026-09-02',NULL,NULL,1,1,NULL,NULL);`);
  migrateManagementActions(db);
  db.prepare("INSERT INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES ('x','overdue_task','member',NULL,?,'sent')").run(DAY - 60_000);
  assert.equal(planFollowups(db, config, DAY).filter(plan => plan.kind === 'overdue_task').length, 0);
  // ...and a silent-task nudge never stacks on top of it the same day either.
  assert.equal(planFollowups(db, config, DAY).filter(plan => plan.kind === 'silent_task').length, 0);
});

test('an unowned task still nudges Basim per task -- its options are employees, not tasks', t => {
  const { db, config } = fixture(t);
  db.exec(`INSERT INTO tasks VALUES
    ('u1','بلا مسؤول','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL),
    ('u2','بلا مسؤول ثانية','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL);`);
  const plans = planFollowups(db, config, NIGHT).filter(plan => plan.kind === 'unowned_task');
  assert.equal(plans.length, 2, 'these cannot share one poll -- each option is a person to assign, not a task');
  assert.deepEqual(plans.map(p => p.entityId), ['u1', 'u2']);
});
