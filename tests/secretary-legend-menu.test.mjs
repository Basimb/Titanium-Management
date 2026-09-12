// Basim's follow-up redesign of the standalone command legend: "نغير
// الاسلوب والطريقه ونطور الاوامر كالتالي: اضافة مهمه ارسل رقم 1 و اضافة
// ملاحظه ارسل رقم 2 وتحويل مهمه ارسل رقم 3 وتمديد التاريخ ارسل رقم 4 وانهاء
// المهمه ارسل رقم 5 ... وطبعا كل ما يضغظ رقم يطلعلو التصويت المناسب ...
// وتلغي الكلام اللي كان مكتوب كملاحظه تحت كل رساله بتجيهم وتغيرو بهذه" --
// covers: the new numbered 1-5 poll/menu text, the new LGDEXTEND (تمديد
// التاريخ) action end to end, and -- critically -- that a bare typed digit
// never hijacks the pre-existing, heavily-tested bare-ordinal task picker
// (bareOwnershipOrdinal in secretary-service.ts) for an employee who
// actually has tasks to pick from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const PROGRESS = '22222222-2222-4222-8222-222222222222';
const PROGRESS2 = '33333333-3333-4333-8333-333333333333';

function fixture(t, { withTasks = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);`);
  if (withTasks) {
    db.exec(`INSERT INTO tasks VALUES
      ('${PROGRESS}','لوحة','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL),
      ('${PROGRESS2}','تصميم','تفاصيل','yellow','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  }
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: '', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (text, infer, extra = {}) => handleSecretaryEvent(db, event({ ...(text !== undefined ? { text } : {}), ...extra }), config, { infer: infer || (async () => { throw Error('must not invoke the model'); }), now: () => now });
  return { db, config, event, run, now };
}
const outbox = db => db.prepare("SELECT to_user AS toUser, text, choices_json AS choicesJson FROM agent_outbox ORDER BY id").all();
function tap(questionId, optionId) { return { choice: { questionId, optionId } }; }

test('the numbered legend menu lists all five commands with their number and color', async t => {
  const f = fixture(t, { withTasks: false }); // exactly one task -- no candidate ambiguity to resolve
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES('${PROGRESS}','لوحة','تفاصيل','red','progress','خالد','خالد',1,1,1)`);
  // A plain "comment" action is the simplest reliable trigger for
  // notifyTaskLegend (see notifyTaskLegend's own call sites).
  await handleSecretaryEvent(f.db, f.event({ text: 'ملاحظة: بدأت الشغل' }), f.config, { infer: async () => ({ ...emptySecretaryIntent('command'), action: 'comment', taskId: PROGRESS, fields: { ...emptySecretaryIntent('command').fields, body: 'بدأت الشغل' } }), now: () => f.now });
  const legend = outbox(f.db).find(r => r.toUser === 'member' && /أوامر المهام السريعة/.test(r.text));
  assert.ok(legend, 'the employee must get the redesigned numbered legend');
  assert.match(legend.text, /1️⃣.*اضافة مهمة/);
  assert.match(legend.text, /2️⃣.*اضافة ملاحظة/);
  assert.match(legend.text, /3️⃣.*تحويل المهمة/);
  assert.match(legend.text, /4️⃣.*تمديد التاريخ/);
  assert.match(legend.text, /5️⃣.*انهاء المهمة/);
  const choices = JSON.parse(legend.choicesJson);
  assert.deepEqual(choices.options.map(o => o.id), ['LGDADD', 'LGDNOTE', 'LGDTRANSFER', 'LGDEXTEND', 'LGDFINISH']);
});

test('tapping LGDEXTEND with exactly one eligible task rewrites deterministically to that task\'s own extend sentence', async t => {
  const f = fixture(t, { withTasks: false });
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES('${PROGRESS}','لوحة','تفاصيل','red','progress','خالد','خالد',1,1,1)`);
  let seen;
  await f.run(undefined, async input => { seen = input.text; return emptySecretaryIntent('clarify', 'شو الموعد الجديد؟'); }, tap('LGDQ', 'LGDEXTEND'));
  assert.equal(seen, 'بدي أمدد موعد مهمة «لوحة»');
});

// Basim (2026-09-12): "لما تظهر زي هاي الحالة ما يستخدم ارقام المهام...
// عدلها" -- with 2+ eligible tasks, letting the model free-associate "which
// task?" produced a wall of full task titles (sometimes its own separate
// ad-hoc poll) instead of the real numbered tap-to-choose list FINISH/
// TRANSFER/NOTE already give, and it asked "كم يوم؟" before ever resolving
// which task. LGDEXTEND now takes the exact same deterministic path.
test('tapping LGDEXTEND with two eligible tasks offers the same real numbered poll FINISH/TRANSFER/NOTE already give, instead of ever asking the model', async t => {
  const f = fixture(t, { withTasks: true }); // خالد owns two progress tasks here
  const r = await f.run(undefined, undefined, tap('LGDQ', 'LGDEXTEND'));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /أكثر من مهمة/);
  assert.ok(r.choices, 'must offer a real tappable poll, not a free-text bullet list');
  assert.equal(r.choices.id.slice(0, 3), 'TDQ');
  assert.deepEqual(r.choices.options.map(o => o.label), ['لوحة', 'تصميم']);
});

test('tapping the LGDEXTEND disambiguation poll names the tapped task and asks for the new date, carrying its id as taskId for the next plain message', async t => {
  const f = fixture(t, { withTasks: true });
  const first = await f.run(undefined, undefined, tap('LGDQ', 'LGDEXTEND'));
  const designOption = first.choices.options.find(o => o.label === 'تصميم');
  const tapped = await f.run(undefined, undefined, tap(first.choices.id, designOption.id));
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /تصميم/);
  assert.match(tapped.reply, /مدة|تاريخ/);
  assert.equal(tapped.taskId, PROGRESS2, 'must carry the TAPPED task (تصميم), so the very next plain message (e.g. "٣") resolves against it via focusedTaskId, never re-asking which task');
  // The poll is single-use.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n, 0);
});

test('tapping LGDEXTEND with zero eligible tasks resolves deterministically to the "no task" reply, exactly like FINISH/NOTE/TRANSFER, never asking the model', async t => {
  const f = fixture(t, { withTasks: false }); // خالد owns nothing here
  const r = await f.run(undefined, undefined, tap('LGDQ', 'LGDEXTEND'));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عندك مهمة قيد التنفيذ حاليًا لتمديد موعدها/);
});

test('typing the bare phrase "تمديد الموعد" resolves exactly like tapping LGDEXTEND', async t => {
  const f = fixture(t, { withTasks: false });
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES('${PROGRESS}','لوحة','تفاصيل','red','progress','خالد','خالد',1,1,1)`);
  let seen;
  await f.run('تمديد الموعد', async input => { seen = input.text; return emptySecretaryIntent('clarify', 'شو الموعد الجديد؟'); });
  assert.equal(seen, 'بدي أمدد موعد مهمة «لوحة»');
});

test('a bare digit "1".."5" resolves to the matching quick command when the employee has no tasks at all to pick from', async t => {
  const f = fixture(t, { withTasks: false });
  let seenAdd; await f.run('1', async input => { seenAdd = input.text; return emptySecretaryIntent('clarify', 'أي مشروع؟'); });
  assert.equal(seenAdd, 'اضافة مهمة', 'digit 1 -- اضافة مهمة');
  const finish = await f.run('5'); // LGDFINISH with zero candidates resolves deterministically, no model call
  assert.equal(finish.status, 'clarify');
  assert.match(finish.reply, /ما عندك مهمة قيد التنفيذ حاليًا لإنهائها/);
  const extend = await f.run('4'); // LGDEXTEND with zero candidates now also resolves deterministically, no model call
  assert.equal(extend.status, 'clarify');
  assert.match(extend.reply, /ما عندك مهمة قيد التنفيذ حاليًا لتمديد موعدها/);
});

// The critical regression: an employee who actually has tasks visible to
// them must still be able to type a bare "1" to pick task #1 off a "شو
// مهامي؟" listing (bareOwnershipOrdinal) -- the new digit-menu shortcut must
// never fire for them, precisely because it can't tell that "1" apart from
// an ordinal pick.
test('a bare digit never hijacks the ordinal task-picker for an employee who has any task at all', async t => {
  const f = fixture(t, { withTasks: false });
  // A task خالد only WATCHES (not owner, not suggested_owner) is exactly the
  // one visible-but-unassigned case where "ownership_request" (bareOwnershipOrdinal's
  // own deterministic resolution, see secretary-service.ts) can actually
  // succeed -- requestTaskOwnership itself refuses when the actor is already
  // that task's owner or suggested owner ("already_assigned").
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,watcher,created_at,updated_at) VALUES('${PROGRESS}','مهمة مرصودة','تفاصيل','yellow','open',NULL,NULL,'خالد',1,1)`);
  const result = await f.run('1'); // must resolve via bareOwnershipOrdinal, deterministically, no model call
  assert.notEqual(result.reply, 'اضافة مهمة');
  assert.equal(result.status, 'applied', 'ownership_request files a request to Basim without ever needing the model');
  assert.match(result.reply, /رفعت طلبك لباسم/);
  const toBasim = outbox(f.db).find(r => r.toUser === 'basem');
  assert.ok(toBasim, 'Basim must be notified of the ownership request');
});

// 2026-09-12 follow-up, per Basim's own explicit live-test complaint: he
// wants "1".."5" to work exactly the same for him as for an employee with no
// tasks -- the earlier admin/basem exclusion below was only ever there to
// avoid colliding with bareOwnershipOrdinal (which he never uses anyway,
// since it unconditionally excludes basem/admin too), so exempting him from
// the ownershipCandidates-empty gate reintroduces no ambiguity.
test('Basim himself now gets the same digit-menu shortcut as an employee with no tasks -- "1" always means اضافة مهمة for him', async t => {
  const f = fixture(t, { withTasks: false });
  let seenText;
  await handleSecretaryEvent(f.db, f.event({ text: '1', senderNumber: '12025550103' }), f.config, { infer: async input => { seenText = input.text; return emptySecretaryIntent('clarify', 'أي مشروع؟'); }, now: () => f.now });
  assert.equal(seenText, 'اضافة مهمة', 'digit 1 always starts add-task for Basim too, per his 2026-09-12 request');
});

test('Basim: a digit with exactly one of his own eligible tasks (e.g. "5" -- finish) resolves deterministically by name', async t => {
  const f = fixture(t, { withTasks: false });
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES('${PROGRESS}','لوحة باسم','تفاصيل','red','progress','باسم','باسم',1,1,1)`);
  let seen;
  await handleSecretaryEvent(f.db, f.event({ text: '5', senderNumber: '12025550103' }), f.config, { infer: async input => { seen = input.text; return emptySecretaryIntent('clarify', 'شو نتيجتها؟'); }, now: () => f.now });
  assert.equal(seen, 'خلصت مهمة «لوحة باسم»');
});

test('Basim: a digit with two or more of his own eligible tasks opens a real tappable poll instead of asking the model', async t => {
  const f = fixture(t, { withTasks: false });
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
    ('${PROGRESS}','لوحة باسم','تفاصيل','red','progress','باسم','باسم',1,1,1),
    ('${PROGRESS2}','تصميم باسم','تفاصيل','yellow','progress','باسم','باسم',1,1,1)`);
  const result = await handleSecretaryEvent(f.db, f.event({ text: '2', senderNumber: '12025550103' }), f.config, { infer: async () => { throw Error('must not invoke the model -- a real poll must be offered instead'); }, now: () => f.now });
  assert.equal(result.status, 'clarify');
  assert.ok(result.choices, 'a real tappable poll must be attached, not just text');
  assert.equal(result.choices.options.length, 2, 'both of his own eligible tasks must be offered as tappable options');
});

test('the ordinal task-picker still never fires for Basim -- exempting him from the digit-menu gate reintroduces no old ambiguity', async t => {
  const f = fixture(t, { withTasks: false });
  // A task he only watches: exactly the shape that would trigger
  // bareOwnershipOrdinal for an employee -- bareOwnershipOrdinal itself
  // still unconditionally excludes basem/admin (unchanged), so this must
  // still resolve via the digit menu, never via an ownership_request.
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,watcher,created_at,updated_at) VALUES('${PROGRESS}','مهمة مرصودة','تفاصيل','yellow','open',NULL,NULL,'باسم',1,1)`);
  let seen;
  await handleSecretaryEvent(f.db, f.event({ text: '1', senderNumber: '12025550103' }), f.config, { infer: async input => { seen = input.text; return emptySecretaryIntent('clarify', 'أي مشروع؟'); }, now: () => f.now });
  assert.equal(seen, 'اضافة مهمة', 'still resolves to the digit-menu action, never an ownership_request for a watched task');
});
