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
  assert.deepEqual(r.choices.options.map(o => o.id), [`TSK${OPEN}CLAIM`, `TSK${OPEN}TRANSFER`, `TSK${OPEN}EDIT`]);
  assert.equal(r.choices.expiresAt - f.now, 60 * 60_000, 'a WhatsApp poll cannot outlive a 1-hour expiry');
});
test('a task already in progress offers the full FINISH/NOTE/TRANSFER/EDIT/EXTEND poll', async t => {
  const f = fixture(t);
  const r = await f.run(details(PROGRESS), { text: 'شو تفاصيل اللوحة؟' });
  assert.deepEqual(r.choices.options.map(o => o.id), [`TSK${PROGRESS}FINISH`, `TSK${PROGRESS}NOTE`, `TSK${PROGRESS}TRANSFER`, `TSK${PROGRESS}EDIT`, `TSK${PROGRESS}EXTEND`]);
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
// Basim's explicit rule: nobody closes a task without a note. FINISH itself
// stays a tap (his original "بدهم بس يختاروا، ما بدي حد يكتب" design), so this
// only checks a note was already logged this work cycle -- via a prior NOTE
// tap/typed comment -- never that the tap itself carries one.
test('tapping FINISH is refused (never asking the model) when no note was logged this work cycle', async t => {
  const f = fixture(t);
  const tapped = await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}FINISH`),
    async () => { throw Error('a FINISH tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /لازم تضيف ملاحظة/);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(PROGRESS).status, 'progress', 'refused -- must not have moved to approval');
});
test('a note logged earlier this work cycle (e.g. via a prior NOTE tap/typed comment) lets FINISH resolve the submit directly and move the task to pending Basim approval', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO comments VALUES(1,?,?,?,?)").run(PROGRESS, 'خالد', 'سلّمت اللوحة للفريق الفني اليوم', f.now - 1000);
  const tapped = await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}FINISH`),
    async () => { throw Error('a FINISH tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(PROGRESS).status, 'approval');
});
// A note left during an EARLIER work cycle on a task that was reopened and
// reclaimed (started_at reset) must never silently satisfy this one.
test('a note from a previous, already-finished work cycle does not satisfy the requirement after the task is reopened and reclaimed', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO comments VALUES(1,?,?,?,?)").run(PROGRESS, 'خالد', 'ملاحظة قديمة من دورة عمل سابقة', 0);
  f.db.prepare("UPDATE tasks SET started_at=? WHERE id=?").run(f.now, PROGRESS); // reclaimed just now, after that old comment
  const tapped = await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}FINISH`),
    async () => { throw Error('a FINISH tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'clarify');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(PROGRESS).status, 'progress');
});
// A FINISH tap never went through requestTaskClose (lib/approvals.ts), so it
// never created a formal approvals row -- before this, dispatchManagementNotice
// sent Basim only a plain-text FYI about the submit with no way at all to act
// on it. taskCloseDecisionPoll/parseTaskCloseDecisionPollChoice close that gap
// with a parallel, approvals-table-free 🟢/🔴 poll keyed by the task itself.
test('a FINISH tap that succeeds sends Basim a real 🟢/🔴 decision poll, not just a plain-text FYI', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO comments VALUES(1,?,?,?,?)").run(PROGRESS, 'خالد', 'سلّمت اللوحة للفريق الفني اليوم', f.now - 1000);
  await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}FINISH`), async () => { throw Error('a FINISH tap must resolve directly, never ask the model'); });
  const toBasim = f.db.prepare("SELECT text, choices_json AS choicesJson FROM agent_outbox WHERE to_user='basem' ORDER BY id DESC LIMIT 1").get();
  assert.match(toBasim.text, /بانتظار اعتماد باسم/);
  assert.ok(toBasim.choicesJson, 'Basim must get a tappable poll, not just an FYI, for a submit with no approvals row behind it');
  const choices = JSON.parse(toBasim.choicesJson);
  assert.equal(choices.id, `TCLQ${PROGRESS}`);
  assert.deepEqual(choices.options.map(o => o.id), [`TCL${PROGRESS}Y`, `TCL${PROGRESS}N`]);
});
test('a plain "claim" notice to Basim never carries the task-close decision poll -- only "submit" does', async t => {
  const f = fixture(t);
  await f.run(undefined, tap(`TSKQ${OPEN}`, `TSK${OPEN}CLAIM`), async () => { throw Error('must not ask the model'); });
  const toBasim = f.db.prepare("SELECT choices_json AS choicesJson FROM agent_outbox WHERE to_user='basem' ORDER BY id DESC LIMIT 1").get();
  assert.equal(toBasim.choicesJson, null);
});
test('Basim tapping 🟢 on the task-close decision poll resolves the approval directly, never asking the model, and completes the task', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare("UPDATE tasks SET status='approval' WHERE id=?").run(PROGRESS);
  const tapped = await f.run(undefined, { ...admin, ...tap(`TCLQ${PROGRESS}`, `TCL${PROGRESS}Y`) },
    async () => { throw Error('a 🟢 tap must resolve directly, never ask the model'); });
  assert.equal(tapped.status, 'applied');
  const task = f.db.prepare('SELECT status,completed_at AS completedAt FROM tasks WHERE id=?').get(PROGRESS);
  assert.equal(task.status, 'completed');
  assert.ok(task.completedAt);
  assert.ok(f.db.prepare("SELECT 1 FROM agent_outbox WHERE to_user='group' AND text LIKE '%اعتُمد إنجاز%'").get(), 'must broadcast the same way any other approval does');
  assert.ok(f.db.prepare("SELECT 1 FROM agent_outbox WHERE to_user='member'").get(), 'خالد (the owner) must get a private heads-up that his submit was approved');
});
test('Basim tapping 🔴 on the task-close decision poll cannot resolve on the tap alone (reject needs a reason) -- it is rewritten to the sentence he would have typed, using the task\'s live title', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare("UPDATE tasks SET status='approval', title=? WHERE id=?").run('لوحة معدّلة', PROGRESS);
  let seenText; const r = await f.run(undefined, { ...admin, ...tap(`TCLQ${PROGRESS}`, `TCL${PROGRESS}N`) },
    async input => { seenText = input.text; return emptySecretaryIntent('clarify', 'شو سبب الرفض بالضبط؟'); });
  assert.equal(seenText, 'بدي أرفض إنجاز مهمة «لوحة معدّلة»');
  assert.equal(r.status, 'clarify');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(PROGRESS).status, 'approval', 'nothing must change before a reason is actually given');
});
test('a task-close decision tap (🟢 or 🔴) for a task removed since the poll was sent is denied cleanly instead of throwing', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(PROGRESS);
  const approved = await f.run(undefined, { ...admin, ...tap(`TCLQ${PROGRESS}`, `TCL${PROGRESS}Y`) }, async () => { throw Error('must not ask the model'); });
  assert.equal(approved.status, 'clarify');
  // 🔴's rewrite-to-text also degrades gracefully with no live task to name --
  // same fallback as resolveTaskActionTextChoice's own NOTE/TRANSFER/EXTEND.
  let seen; await f.run(undefined, { text: '🔴 رفض', ...admin, ...tap(`TCLQ${PROGRESS}`, `TCL${PROGRESS}N`) }, async input => { seen = input.text; return emptySecretaryIntent('chat', 'تمام'); });
  assert.equal(seen, '🔴 رفض');
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
test('tapping NOTE/TRANSFER/EDIT/EXTEND rewrites the tap into the exact sentence a person naming the task would type, using its live title', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('لوحة معدّلة', PROGRESS);
  let seenNote; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}NOTE`), async input => { seenNote = input.text; return emptySecretaryIntent('clarify', 'شو الملاحظة؟'); });
  assert.equal(seenNote, 'بدي أضيف ملاحظة على مهمة «لوحة معدّلة»');
  let seenTransfer; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}TRANSFER`), async input => { seenTransfer = input.text; return emptySecretaryIntent('clarify', 'لمين؟'); });
  assert.equal(seenTransfer, 'بدي أحول مهمة «لوحة معدّلة» لحدا غيري');
  let seenEdit; await f.run(undefined, tap(`TSKQ${PROGRESS}`, `TSK${PROGRESS}EDIT`), async input => { seenEdit = input.text; return emptySecretaryIntent('clarify', 'شو الأولوية الجديدة؟'); });
  assert.equal(seenEdit, 'بدي أعدل أولوية مهمة «لوحة معدّلة»');
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
// Basim: "بدي هذه تتحول تصويت للكل وفي كل مكان" -- the standalone command
// legend (see notifyTaskLegend/TASK_COMMANDS_LEGEND/taskCommandsLegendPoll in
// lib/secretary-service.ts) must now carry its own tappable poll of the same
// four bare commands it already tells people to type, everywhere it's sent.
test('the standalone command legend carries a tappable poll of its own four commands', async t => {
  const f = fixture(t);
  await f.run(undefined, tap(`TSKQ${OPEN}`, `TSK${OPEN}CLAIM`), async () => { throw Error('must not ask the model'); });
  const legend = outbox(f.db).find(r => r.toUser === 'member' && /تذكير بأوامر المهام/.test(r.text));
  assert.ok(legend?.choicesJson, 'the legend message must carry a poll, not go out as plain text alone');
  const choices = JSON.parse(legend.choicesJson);
  assert.equal(choices.id, 'LGDQ');
  assert.deepEqual(choices.options.map(o => o.id), ['LGDTRANSFER', 'LGDFINISH', 'LGDNOTE', 'LGDADD']);
  assert.equal(choices.expiresAt - f.now, 60 * 60_000, 'a WhatsApp poll cannot outlive a 1-hour expiry');
});
// Basim hit this for real: he tapped the legend's generic "انهاء المهمة" on
// a message about a brand-new, still-unclaimed task, and the model quietly
// resolved it to a COMPLETELY DIFFERENT task خالد already had in progress
// and raised THAT one for Basim's approval -- because the old rewrite sent
// the model the bare word with no task named at all, and the model picked
// one on its own instead of asking. The fix: never had the model choose
// among the actor's own tasks -- resolve deterministically here, and only
// when there is truly one possible task to mean.
test('LGDADD always rewrites outright -- a brand-new task touches no existing record, so no ambiguity is possible', async t => {
  const f = fixture(t);
  let seenAdd; await f.run(undefined, tap('LGDQ', 'LGDADD'), async input => { seenAdd = input.text; return emptySecretaryIntent('clarify', 'أي مشروع؟'); });
  assert.equal(seenAdd, 'اضافة مهمة');
});
test('LGDFINISH/LGDNOTE resolve to the actor\'s one eligible (in-progress, owned) task by name, never the bare word', async t => {
  const f = fixture(t); // خالد owns exactly one in-progress task here: PROGRESS ("لوحة")
  let seenFinish; await f.run(undefined, tap('LGDQ', 'LGDFINISH'), async input => { seenFinish = input.text; return emptySecretaryIntent('clarify', 'شو صار؟'); });
  assert.equal(seenFinish, 'خلصت مهمة «لوحة»');
  let seenNote; await f.run(undefined, tap('LGDQ', 'LGDNOTE'), async input => { seenNote = input.text; return emptySecretaryIntent('clarify', 'شو الملاحظة؟'); });
  assert.equal(seenNote, 'بدي أضيف ملاحظة على مهمة «لوحة»');
});
test('LGDTRANSFER asks which task, without ever invoking the model, when the actor has more than one eligible task', async t => {
  const f = fixture(t); // خالد has BOTH the open-suggested task and the in-progress one -- transfer applies to either
  const r = await f.run(undefined, tap('LGDQ', 'LGDTRANSFER'), async () => { throw Error('must not ask the model to pick among several tasks'); });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /أكثر من مهمة/);
  assert.match(r.reply, /مهمة مقترحة/); assert.match(r.reply, /لوحة/);
});
test('LGDFINISH/LGDNOTE/LGDTRANSFER say so plainly, without ever invoking the model, when the actor has no eligible task at all', async t => {
  const f = fixture(t); const noTasks = { senderNumber: '12025550102' }; // شادي owns nothing in this fixture
  const finish = await f.run(undefined, { ...noTasks, ...tap('LGDQ', 'LGDFINISH') }, async () => { throw Error('must not ask the model'); });
  assert.equal(finish.status, 'clarify'); assert.match(finish.reply, /ما عندك مهمة قيد التنفيذ حاليًا لإنهائها/);
  const transfer = await f.run(undefined, { ...noTasks, ...tap('LGDQ', 'LGDTRANSFER') }, async () => { throw Error('must not ask the model'); });
  assert.match(transfer.reply, /ما عندك مهمة مفتوحة أو قيد التنفيذ حاليًا لتحويلها/);
});
test('a task newly reassigned through chat privately notifies the new owner with a CLAIM/TRANSFER poll of their own', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  const p = { ...emptySecretaryIntent('command'), action: 'reassign', taskId: PROGRESS, fields: { ...emptySecretaryIntent('command').fields, ownerId: 'other' } };
  const preview = await f.run(p, { ...admin, text: 'حول اللوحة لشادي' });
  assert.equal(preview.status, 'confirmation');
  const token = f.db.prepare('SELECT token FROM secretary_pending').get().token;
  const result = await f.run(undefined, { ...admin, text: `موافق ${token}` });
  assert.equal(result.status, 'applied');
  const toNewOwnerRows = f.db.prepare("SELECT text, choices_json AS choicesJson FROM agent_outbox WHERE to_user='other' ORDER BY id").all();
  const toNewOwner = toNewOwnerRows.find(r => r.choicesJson);
  assert.ok(toNewOwner, 'the newly assigned owner must get a tappable poll, not just plain text');
  const choices = JSON.parse(toNewOwner.choicesJson);
  assert.equal(choices.id, `TSKQ${PROGRESS}`);
  assert.deepEqual(choices.options.map(o => o.id), [`TSK${PROGRESS}CLAIM`, `TSK${PROGRESS}TRANSFER`, `TSK${PROGRESS}EDIT`], 'the task is open again after reassignment, so CLAIM/TRANSFER/EDIT apply, not FINISH/NOTE/EXTEND');
  // Basim hit this for real: the standalone command legend used to follow
  // this task poll as a SECOND poll to the same person a millisecond later,
  // which silently superseded (broke the tap-ability of) the CLAIM poll
  // above at the WhatsApp bridge layer (polls.mjs treats one new poll per
  // phone number as invalidating whatever poll was still live for it) --
  // so "استلمت المهمة" looked like it was offered but never actually worked.
  // The legend must still reach him as plain text, just never as a
  // competing poll when a task-specific one was already attached.
  const legend = toNewOwnerRows.find(r => /تذكير بأوامر المهام/.test(r.text));
  assert.ok(legend, 'the newly assigned owner still gets the plain-text command legend');
  assert.equal(legend.choicesJson, null, 'the legend must never carry its own poll here -- it would silently invalidate the CLAIM/TRANSFER/EDIT poll just sent to the same person');
});
// Basim's explicit correction after rejecting reassign as a workaround: "انا
// مابدي احول مهمه بدي اقولو يستلم مهمه محوله اله اساسا بس ما استلمها" -- nudge
// must resend خالد's already-live claim/action poll for OPEN, with zero
// change to the task itself, and no "موافق TOKEN" confirmation step at all.
function nudge(taskId) { return { ...emptySecretaryIntent('nudge'), taskId }; }
test('nudge resends the current owner/suggested-owner their exact claim poll, right away, with no confirmation step and no task mutation', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  const before = f.db.prepare('SELECT status,owner,suggested_owner AS suggestedOwner FROM tasks WHERE id=?').get(OPEN);
  const r = await f.run(nudge(OPEN), { ...admin, text: 'ذكّر خالد يستلم المهمة المقترحة' });
  assert.equal(r.status, 'applied', 'nudge must resolve immediately, unlike reassign which needs a موافق confirmation');
  const after = f.db.prepare('SELECT status,owner,suggested_owner AS suggestedOwner FROM tasks WHERE id=?').get(OPEN);
  assert.deepEqual(after, before, 'nudge must never change the task record itself');
  const toMemberRows = f.db.prepare("SELECT text, choices_json AS choicesJson FROM agent_outbox WHERE to_user='member' ORDER BY id").all();
  const poll = toMemberRows.find(row => row.choicesJson);
  assert.ok(poll, 'خالد must get a real tappable poll, not just a plain-text nudge');
  const choices = JSON.parse(poll.choicesJson);
  assert.equal(choices.id, `TSKQ${OPEN}`);
  assert.deepEqual(choices.options.map(o => o.id), [`TSK${OPEN}CLAIM`, `TSK${OPEN}TRANSFER`, `TSK${OPEN}EDIT`], 'the exact same poll the task is already offering, not a new/different one');
  const legend = toMemberRows.find(row => /تذكير بأوامر المهام/.test(row.text));
  assert.ok(legend, 'خالد still gets the plain-text command legend');
  assert.equal(legend.choicesJson, null, 'the legend must never carry its own poll here -- it would silently invalidate the CLAIM/TRANSFER/EDIT poll just sent to the same person');
});
test('nudge on a task already in progress resends the FINISH/NOTE/TRANSFER/EDIT/EXTEND poll to its current owner', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  const r = await f.run(nudge(PROGRESS), { ...admin, text: 'ذكّر خالد باللوحة' });
  assert.equal(r.status, 'applied');
  const poll = f.db.prepare("SELECT choices_json AS choicesJson FROM agent_outbox WHERE to_user='member' AND choices_json IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(poll.choicesJson).options.map(o => o.id), [`TSK${PROGRESS}FINISH`, `TSK${PROGRESS}NOTE`, `TSK${PROGRESS}TRANSFER`, `TSK${PROGRESS}EDIT`, `TSK${PROGRESS}EXTEND`]);
});
test('nudge on a task with no owner or suggested owner at all is refused cleanly instead of nudging nobody', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare('UPDATE tasks SET suggested_owner=NULL WHERE id=?').run(OPEN);
  const r = await f.run(nudge(OPEN), { ...admin, text: 'ذكّر بالمهمة المقترحة' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما إلها مسؤول/);
});
test('nudge refuses to let Basim "remind" himself about his own task', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare("UPDATE tasks SET owner='باسم', suggested_owner=NULL WHERE id=?").run(PROGRESS);
  const r = await f.run(nudge(PROGRESS), { ...admin, text: 'ذكرني باللوحة' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /مهمتك انت/);
});
test('nudge on an archived/removed task is denied cleanly instead of throwing', async t => {
  const f = fixture(t); const admin = { senderNumber: '12025550103' };
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(OPEN);
  const r = await f.run(nudge(OPEN), { ...admin, text: 'ذكّر خالد' });
  assert.equal(r.status, 'clarify');
});
test('a duplicate delivery of the same details view replays the identical poll for the employee, never denied', async t => {
  const f = fixture(t);
  const extra = { messageId: 'DUP-1', responseMessageId: 'DUP-REPLY-1', text: 'شو تفاصيل مهمتي المقترحة؟' };
  const first = await f.run(details(OPEN), extra);
  const second = await f.run(details(OPEN), extra, async () => { throw Error('a duplicate delivery must never reinvoke the model'); });
  assert.equal(second.status, 'duplicate');
  assert.deepEqual(second.choices, first.choices, 'the replayed poll must be identical, not silently dropped');
});
