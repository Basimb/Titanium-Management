// Basim's dictated ask: "تحت كل مهمة ثلاث نقاط... لإنهاء المهمة اضغط هنا،
// لتعديل المهمة اضغط هنا، لتمديد المهمة اضغط هنا... ما بدي حد يكتب ولا حد
// يعمل، بدهم بس يختاروا" -- a tappable poll under an employee's own task,
// not just Basim's approvals (see approvalDecisionPoll/parseApprovalPollChoice
// for the pattern this reuses). taskActionPoll/parseTaskActionPollChoice/
// resolveTaskActionTextChoice in lib/secretary-service.ts implement it.
//
// Real task ids are randomUUID() (see lib/management-actions.ts), and
// parseTaskActionPollChoice validates the shape of the id it pulls off a
// tapped option -- same defense-in-depth parseApprovalPollChoice already
// applies to approval ids -- so this fixture uses UUID-shaped ids too rather
// than the short 't'/'t2' placeholders other secretary-service fixtures use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const OPEN = '11111111-1111-4111-8111-111111111111';
const PROGRESS = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
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
    INSERT INTO tasks VALUES
      ('${OPEN}','p','مهمة مقترحة','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL),
      ('${PROGRESS}','p','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (plan = emptySecretaryIntent('summary'), extra = {}, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => plan), now: () => now });
  return { db, config, event, run, now };
}
const outbox = db => db.prepare("SELECT to_user AS toUser, text, choices_json AS choicesJson FROM agent_outbox ORDER BY id").all();
function details(taskId) { return { ...emptySecretaryIntent('details'), taskId }; }
function tap(questionId, optionId) { return { choice: { questionId, optionId } }; }

test('an unclaimed task suggested to an employee offers a CLAIM/TRANSFER poll, never a single-option one', async t => {
  const f = fixture(t);
  const r = await f.run(details(OPEN), { text: 'شو تفاصيل مهمتي المقترحة؟' }); // default sender is خالد (member)
  assert.equal(r.status, 'summary');
  assert.ok(r.choices, 'an unclaimed suggested task must offer a poll');
  assert.equal(r.choices.id, `TSKQ${OPEN}`);
  assert.deepEqual(r.choices.options.map(o => o.id), [`TSK${OPEN}CLAIM`, `TSK${OPEN}TRANSFER`]);
  assert.equal(r.choices.expiresAt - f.now, 60 * 60_000, 'a WhatsApp poll cannot outlive a 1-hour expiry');
});
test('a task already in progress offers the full FINISH/NOTE/TRANSFER/EXTEND poll', async t => {
  const f = fixture(t);
  const r = await f.run(details(PROGRESS), { text: 'شو تفاصيل اللوحة؟' });
  assert.deepEqual(r.choices.options.map(o => o.id), [`TSK${PROGRESS}FINISH`, `TSK${PROGRESS}NOTE`, `TSK${PROGRESS}TRANSFER`, `TSK${PROGRESS}EXTEND`]);
});
test('a task view from the group, or of someone else\'s task, never carries a poll', async t => {
  const f = fixture(t);
  const fromGroup = await f.run(details(PROGRESS), { groupId: '12345@g.us', text: 'يا سكرتير شو تفاصيل اللوحة؟' });
  assert.equal(fromGroup.choices, undefined);
  const other = await f.run(details(PROGRESS), { senderNumber: '12025550102', text: 'شو تفاصيل اللوحة؟' }); // شادي asking about خالد's task
  assert.equal(other.choices, undefined);
});
test('tapping CLAIM resolves the claim directly, never asking the model, and broadcasts exactly like typing "استلمت" would', async t => {
  const f = fixture(t);
  const tapped = await f.run(undefined, tap(`TSKQ${OPEN}`, `TSK${OPEN}CLAIM`),
    async () => { throw Error('a CLAIM tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  const task = f.db.prepare('SELECT status,owner FROM tasks WHERE id=?').get(OPEN);
  assert.equal(task.status, 'progress'); assert.equal(task.owner, 'خالد');
  const rows = outbox(f.db);
  assert.ok(rows.some(r => r.toUser === 'group' && /👋/.test(r.text)), 'a claim tap must broadcast to the group exactly like a typed claim');
  assert.ok(rows.some(r => r.toUser === 'member' && /تذكير بأوامر المهام/.test(r.text)), 'the tapping employee still gets the command legend');
});
test('tapping FINISH resolves the submit directly and moves the task to pending Basim approval', async t => {
  const f = fixture(t);
  const tapped = await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}FINISH`),
    async () => { throw Error('a FINISH tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(PROGRESS).status, 'approval');
});
test('a stale CLAIM tap (task already claimed by someone else since the poll was sent) fails cleanly instead of throwing', async t => {
  const f = fixture(t);
  f.db.prepare("UPDATE tasks SET status='progress', owner='شادي' WHERE id=?").run(OPEN);
  const tapped = await f.run(undefined, tap(`TSKQ${OPEN}`, `TSK${OPEN}CLAIM`),
    async () => { throw Error('must not ask the model'); });
  assert.equal(tapped.status, 'clarify');
  assert.equal(f.db.prepare('SELECT owner FROM tasks WHERE id=?').get(OPEN).owner, 'شادي', 'unchanged by the failed tap');
});
test('a CLAIM tap for a task removed since the poll was sent is denied cleanly', async t => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(OPEN);
  const tapped = await f.run(undefined, tap(`TSKQ${OPEN}`, `TSK${OPEN}CLAIM`),
    async () => { throw Error('must not ask the model'); });
  assert.equal(tapped.status, 'clarify');
});
test('tapping NOTE/TRANSFER/EXTEND rewrites the tap into the exact sentence a person naming the task would type, using its live title', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('لوحة معدّلة', PROGRESS);
  let seenNote; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}NOTE`), async input => { seenNote = input.text; return emptySecretaryIntent('clarify', 'شو الملاحظة؟'); });
  assert.equal(seenNote, 'بدي أضيف ملاحظة على مهمة «لوحة معدّلة»');
  let seenTransfer; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}TRANSFER`), async input => { seenTransfer = input.text; return emptySecretaryIntent('clarify', 'لمين؟'); });
  assert.equal(seenTransfer, 'بدي أحول مهمة «لوحة معدّلة» لحدا غيري');
  let seenExtend; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}EXTEND`), async input => { seenExtend = input.text; return emptySecretaryIntent('clarify', 'لأي تاريخ؟'); });
  assert.equal(seenExtend, 'بدي أمدد موعد مهمة «لوحة معدّلة»');
});
test('a NOTE/TRANSFER/EXTEND tap for a task removed since the poll was sent falls back to the raw tap text instead of crashing', async t => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(PROGRESS);
  // The bridge always seeds a poll-tap event's text with the tapped option's
  // own label (see polls.mjs) before any rewrite -- with the task gone,
  // resolveTaskActionTextChoice has nothing to rewrite it into and leaves it.
  let seen; await f.run(undefined, { text: '📝 أضيف ملاحظة', ...tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}NOTE`) }, async input => { seen = input; return emptySecretaryIntent('chat', 'تمام'); });
  assert.equal(seen.text, '📝 أضيف ملاحظة', 'the poll option label, since there is no live task left to rewrite around');
});
test('a task newly reassigned through chat privately notifies the new owner with a CLAIM/TRANSFER poll of their own', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  const p = { ...emptySecretaryIntent('command'), action: 'reassign', taskId: PROGRESS, fields: { ...emptySecretaryIntent('command').fields, ownerId: 'other' } };
  const preview = await f.run(p, { ...admin, text: 'حول اللوحة لشادي' });
  assert.equal(preview.status, 'confirmation');
  const token = f.db.prepare('SELECT token FROM secretary_pending').get().token;
  const result = await f.run(undefined, { ...admin, text: `موافق ${token}` });
  assert.equal(result.status, 'applied');
  const toNewOwner = f.db.prepare("SELECT choices_json AS choicesJson FROM agent_outbox WHERE to_user='other'").get();
  assert.ok(toNewOwner?.choicesJson, 'the newly assigned owner must get a tappable poll, not just plain text');
  const choices = JSON.parse(toNewOwner.choicesJson);
  assert.equal(choices.id, `TSKQ${PROGRESS}`);
  assert.deepEqual(choices.options.map(o => o.id), [`TSK${PROGRESS}CLAIM`, `TSK${PROGRESS}TRANSFER`], 'the task is open again after reassignment, so CLAIM/TRANSFER apply, not FINISH/NOTE/EXTEND');
});
test('a duplicate delivery of the same details view replays the identical poll for the employee, never denied', async t => {
  const f = fixture(t);
  const extra = { messageId: 'DUP-1', responseMessageId: 'DUP-REPLY-1', text: 'شو تفاصيل مهمتي المقترحة؟' };
  const first = await f.run(details(OPEN), extra);
  const second = await f.run(details(OPEN), extra, async () => { throw Error('a duplicate delivery must never reinvoke the model'); });
  assert.equal(second.status, 'duplicate');
  assert.deepEqual(second.choices, first.choices, 'the replayed poll must be identical, not silently dropped');
});
