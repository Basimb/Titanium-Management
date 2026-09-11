// Basim's report: "بس نكتب اي امر مثلا انهاء مهمه او تحويل مهمه او اضافة
// ملاحظه ما بيعطي اختيارات لاي مهمه وعلى الاغلب البوت بيختار اول مهمه قيد
// التفيذ او مبعرف على اساس بيقرر" -- typing "انهاء المهمة"/"تحويل المهمة"/
// "اضافة ملاحظة" (close_request/task_transfer_request/a "comment" command)
// with more than one eligible task open let the MODEL's own taskId guess
// through untested, exactly like legendCandidates/LGDQ already had to solve
// once before for the tapped legend reminder (see
// secretary-task-action-poll.test.mjs's own "LGDADD always rewrites..." tests).
// This file covers the same fix applied to a person's own TYPED command: one
// real eligible candidate silently corrects whatever taskId the model
// returned (never trusting the guess even when it happened to be right),
// several candidates stop before any action runs and offer a real tappable
// poll (TDQ) instead, which then finishes the exact original command --
// note text, transfer target, close details -- once tapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const OPEN = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

function fixture(t, { secondTask = true } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('${OPEN}','p','مهمة مقترحة','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL),
      ('${A}','p','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL)
      ${secondTask ? `,('${B}','p','تسليم التقرير','','yellow','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL)` : ''};`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (plan = emptySecretaryIntent('summary'), extra = {}, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => plan), now: () => now });
  return { db, config, event, run, now };
}
function tap(questionId, optionId) { return { choice: { questionId, optionId } }; }
function closeRequest(taskId, details) {
  const base = emptySecretaryIntent('close_request');
  return { ...base, taskId, fields: { ...base.fields, details } };
}
function transferRequest(taskId, ownerId) {
  const base = emptySecretaryIntent('task_transfer_request');
  return { ...base, taskId, fields: { ...base.fields, ownerId } };
}
function commentCommand(taskId, body) {
  const base = emptySecretaryIntent('command');
  return { ...base, action: 'comment', taskId, fields: { ...base.fields, body } };
}

test('close_request ("انهاء المهمة") with two eligible in-progress tasks stops for a real tappable poll instead of trusting whichever one the model guessed', async t => {
  const f = fixture(t);
  const r = await f.run(closeRequest(A, 'خلصت التنفيذ'), { text: 'انهيت المهمة' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /أكثر من مهمة/);
  assert.ok(r.choices, 'must offer a real tappable poll, not just a plain-text list');
  assert.equal(r.choices.id.slice(0, 3), 'TDQ');
  assert.deepEqual(r.choices.options.map(o => o.label), ['لوحة', 'تسليم التقرير']);
  // Nothing must have happened yet -- no approval filed, no task touched.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});
test('tapping the disambiguation poll finishes the exact close_request that was typed, against the tapped task only', async t => {
  const f = fixture(t);
  const first = await f.run(closeRequest(A, 'خلصت التنفيذ بالكامل'), { text: 'انهيت المهمة' });
  const token = first.choices.id.slice(3);
  const tapped = await f.run(undefined, tap(first.choices.id, first.choices.options[1].id),
    async () => { throw Error('a disambiguation tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  const approval = f.db.prepare("SELECT entity_id AS entityId, summary FROM approvals WHERE type='task_close'").get();
  assert.equal(approval.entityId, B, 'must file the close request against the TAPPED task (تسليم التقرير), never A');
  assert.match(approval.summary, /تسليم التقرير/);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(B).status, 'approval');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(A).status, 'progress', 'the OTHER candidate must be untouched');
  // The poll is single-use.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n, 0);
  void token;
});
test('task_transfer_request ("تحويل المهمة") with several eligible tasks (open-suggested + two in-progress) also stops for a poll', async t => {
  const f = fixture(t);
  const r = await f.run(transferRequest(A, 'other'), { text: 'بدي احول المهمة لشادي' });
  assert.equal(r.status, 'clarify');
  assert.ok(r.choices);
  assert.deepEqual(r.choices.options.map(o => o.label), ['مهمة مقترحة', 'لوحة', 'تسليم التقرير']);
});
test('tapping the transfer disambiguation poll files the transfer request against the tapped task, carrying the suggested new owner through', async t => {
  const f = fixture(t);
  const first = await f.run(transferRequest(A, 'other'), { text: 'بدي احول المهمة لشادي' });
  const boardOption = first.choices.options.find(o => o.label === 'لوحة');
  const tapped = await f.run(undefined, tap(first.choices.id, boardOption.id),
    async () => { throw Error('a disambiguation tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  const approval = f.db.prepare("SELECT entity_id AS entityId, payload FROM approvals WHERE type='task_transfer'").get();
  assert.equal(approval.entityId, A, 'must file against the TAPPED task (لوحة)');
  assert.match(JSON.parse(approval.payload).suggestedOwnerName ?? '', /شادي/);
});
test('a typed "comment"/"اضافة ملاحظة" with two eligible tasks stops for a poll and, once tapped, adds the note to the tapped task only', async t => {
  const f = fixture(t);
  const first = await f.run(commentCommand(A, 'التقرير جاهز للمراجعة'), { text: 'اضافة ملاحظة: التقرير جاهز للمراجعة' });
  assert.equal(first.status, 'clarify');
  assert.ok(first.choices);
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  const tapped = await f.run(undefined, tap(first.choices.id, reportOption.id),
    async () => { throw Error('a disambiguation tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  assert.ok(f.db.prepare("SELECT 1 FROM comments WHERE task_id=? AND body=?").get(B, 'التقرير جاهز للمراجعة'), 'the note must land on the TAPPED task (تسليم التقرير)');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id=?').get(A).n, 0, 'the other candidate must be untouched');
});
test('with exactly one eligible task, close_request silently uses it and ignores whatever (wrong) taskId the model actually guessed', async t => {
  const f = fixture(t, { secondTask: false }); // خالد now owns only A ("لوحة") as an in-progress task
  // The model wrongly points at OPEN (not even claimed yet) -- exactly the
  // failure Basim reported ("بيختار... مبعرف على اساس"). legendCandidates
  // must override this to the one real candidate instead of ever letting it
  // through, since OPEN is not even a status close_request should touch.
  const r = await f.run(closeRequest(OPEN, 'خلصت الشغل'), { text: 'انهيت المهمة' });
  assert.equal(r.status, 'applied');
  const approval = f.db.prepare("SELECT entity_id AS entityId FROM approvals WHERE type='task_close'").get();
  assert.equal(approval.entityId, A, 'must file against the one real candidate, never the wrongly guessed OPEN task');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(A).status, 'approval');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(OPEN).status, 'open', 'the wrongly guessed task must be completely untouched');
});
test('with no eligible task at all, the disambiguation check does not fire and the normal (existing) close_request handling still applies', async t => {
  const f = fixture(t); const noTasks = { senderNumber: '12025550102' }; // شادي owns nothing here
  const r = await f.run(closeRequest(A, 'خلصت'), { ...noTasks, text: 'انهيت المهمة' });
  // شادي has zero LGDFINISH-eligible tasks of his own, so legendCandidates()
  // returns [] here and this fix intentionally leaves plan.taskId (a task
  // that isn't even his) for the existing, unrelated visibility checks
  // further downstream to reject on their own terms.
  assert.notEqual(r.status, 'applied');
});
test('a stale/expired disambiguation poll tap is refused cleanly instead of throwing or silently acting on the wrong task', async t => {
  const f = fixture(t);
  const first = await f.run(closeRequest(A, 'خلصت'), { text: 'انهيت المهمة' });
  const staleOptionId = `${first.choices.id}_99`;
  const r = await f.run(undefined, tap(first.choices.id, staleOptionId), async () => { throw Error('must not ask the model'); });
  assert.equal(r.status, 'clarify');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});
test('Basim himself is never subject to this disambiguation -- close_request/task_transfer_request from him pass through exactly as before', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  // Basim closing خالد's own task directly (he can be a task's own worker,
  // see close_request's "owner" branch) must never be blocked by a poll --
  // legendCandidates was only ever meant for an employee's OWN self-service
  // commands, never Basim's admin flow.
  const r = await f.run(closeRequest(A, 'تم الانتهاء'), { ...admin, text: 'خلصت اللوحة' });
  assert.notEqual(r.status, 'clarify');
});
