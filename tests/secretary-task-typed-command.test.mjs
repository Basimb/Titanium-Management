// Basim's follow-up report, after secretary-task-disambiguation.test.mjs's own
// fix (re-verifying/overriding whatever taskId the MODEL guessed) still
// wasn't enough: خالد typed "انهاء المهمة" with two eligible tasks open and
// got the exact same broken numbered-list "clarify" reply twice in a row,
// because the model itself sometimes classifies a bare command like this as
// a generic "clarify" (no taskId at all) instead of close_request/
// task_transfer_request/comment -- and when that happens, the existing
// verify-branch (which only runs once plan.kind is ALREADY one of those
// three) never even fires.
//
// Basim, after discussion, asked specifically for these three commands --
// finish/close ("انهاء المهمة"), transfer/decline ("تحويل المهمة"), and
// add a note/update ("اضافة ملاحظة") -- to bypass the model ENTIRELY when
// typed as a bare, standalone phrase: legendTypedPhraseOption/
// resolveTaskCommandsLegendChoice (lib/secretary-service.ts) now detect
// these exact phrases up front and resolve them the same deterministic way
// tapping the 🧭 command legend already does (legendCandidates), including a
// REAL tappable poll (taskChoicePoll) when more than one task qualifies --
// never the old plain numbered list nobody could tap. He explicitly excluded
// "claim" from this fix: claiming only ever happens by tapping a poll the
// system already sends, never by typing free text, so it needed no change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const OPEN = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const neverAsk = async () => { throw new Error('must not ask the model -- this phrase must resolve deterministically'); };

function fixture(t, { secondTask = true, owner = 'خالد' } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('${OPEN}','مهمة مقترحة','','yellow','open',NULL,'خالد',NULL,NULL,NULL,NULL,1,1,NULL,NULL),
      ('${A}','لوحة','تفاصيل تنفيذ','red','progress','${owner}','${owner}',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL)
      ${secondTask ? `,('${B}','تسليم التقرير','','yellow','progress','${owner}','${owner}',1,NULL,NULL,NULL,1,1,NULL,NULL)` : ''};`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (extra = {}, infer = neverAsk) => handleSecretaryEvent(db, event(extra), config, { infer, now: () => now });
  return { db, config, event, run, now };
}
function tap(questionId, optionId) { return { choice: { questionId, optionId } }; }

test('a bare "انهاء المهمة" with two eligible tasks stops for a real tappable poll without ever asking the model', async t => {
  const f = fixture(t);
  const r = await f.run({ text: 'انهاء المهمة' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /أكثر من مهمة/);
  assert.ok(r.choices, 'must offer a real tappable poll, not a plain-text list');
  assert.equal(r.choices.id.slice(0, 3), 'TDQ');
  assert.deepEqual(r.choices.options.map(o => o.label), ['لوحة', 'تسليم التقرير']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});
test('natural variants of "finish" ("خلصت المهمة"/"خلصتها") resolve exactly the same way', async t => {
  const f1 = fixture(t); const r1 = await f1.run({ text: 'خلصت المهمة' });
  assert.equal(r1.status, 'clarify'); assert.ok(r1.choices);
  const f2 = fixture(t); const r2 = await f2.run({ text: 'خلصتها' });
  assert.equal(r2.status, 'clarify'); assert.ok(r2.choices);
});
// Basim tested this fix himself right after it first shipped by typing
// exactly these three messages, and every one of them MISSED (the model got
// consulted and produced its own generic "أذكر اسم المهمة التي تود
// إنهاءها" instead of the deterministic poll) -- casual WhatsApp typing
// drops the definite article ("مهمه" instead of "المهمة") and spells the
// tied-ta as a plain ه, and the first version of LEGEND_TYPED_PHRASES only
// matched the fully-spelled formal forms. Locks in the fix (ة/ه folding +
// optional "ال") against regressing on his own exact words.
test('Basim\'s own casual phrasing ("انهاء مهمه"/"انهيت مهمه"/"خلصت مهمه", no "ال", ه instead of ة) is matched, not left for the model', async t => {
  for (const text of ['انهاء مهمه', 'انهيت مهمه', 'خلصت مهمه']) {
    const f = fixture(t);
    const r = await f.run({ text });
    assert.equal(r.status, 'clarify', `"${text}" must resolve deterministically`);
    assert.ok(r.choices, `"${text}" must offer a real tappable poll`);
    assert.equal(r.choices.id.slice(0, 3), 'TDQ');
  }
});
test('tapping the deterministic finish poll resolves against the tapped task and asks for the missing result instead of guessing one', async t => {
  const f = fixture(t);
  const first = await f.run({ text: 'انهاء المهمة' });
  const tapped = await f.run(tap(first.choices.id, first.choices.options[1].id), neverAsk);
  // A bare "انهاء المهمة" never said WHAT was finished -- close_request always
  // needs a result (see secretary-agent.ts's own "شو نتيجة..." clarify), so
  // this is the correct, graceful next question, not a bug: the important
  // part already happened deterministically -- it asks about the TAPPED
  // task (تسليم التقرير), never A, and the model was never consulted.
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /تسليم التقرير/);
  assert.equal(tapped.taskId, B);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});
test('retyping the same bare phrase again before tapping replaces the stale poll instead of colliding with it', async t => {
  const f = fixture(t);
  const first = await f.run({ text: 'انهاء المهمة' });
  const second = await f.run({ text: 'انهاء المهمة' });
  assert.equal(second.status, 'clarify'); assert.ok(second.choices);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n, 1, 'the stale row must be replaced, not duplicated');
  const staleTap = await f.run(tap(first.choices.id, first.choices.options[0].id), neverAsk);
  assert.equal(staleTap.status, 'clarify');
  assert.match(staleTap.reply, /ما عاد صالح/);
});
test('a bare "انهاء المهمة" with exactly one eligible task is rewritten to the equivalent named sentence and still goes through the model', async t => {
  const f = fixture(t, { secondTask: false }); // خالد now owns only A ("لوحة")
  let seenText = null;
  const r = await f.run({ text: 'انهاء المهمة' }, async input => { seenText = input.text; return emptySecretaryIntent('clarify', 'ok'); });
  assert.equal(seenText, 'خلصت مهمة «لوحة»', 'the single real candidate must be named before the model ever sees the message');
  void r;
});
test('a bare "انهاء المهمة" with zero eligible tasks gets the legend\'s own "no task" reply without ever asking the model', async t => {
  const f = fixture(t); const noTasks = { senderNumber: '12025550102' }; // شادي owns nothing
  const r = await f.run({ ...noTasks, text: 'انهاء المهمة' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عندك مهمة قيد التنفيذ حاليًا لإنهائها/);
  assert.ok(!r.choices);
});
test('a bare transfer phrase ("تحويل المهمة"/"مش مسؤوليتي") with several eligible tasks (including the still-open, suggested-to-him task) polls, and tapping it fully applies with no extra field required', async t => {
  const f = fixture(t);
  const first = await f.run({ text: 'تحويل المهمة' });
  assert.equal(first.status, 'clarify'); assert.ok(first.choices);
  // LGDTRANSFER's own candidate set (legendCandidates) also includes an
  // "open" task merely SUGGESTED to him (OPEN, suggested_owner=خالد), not
  // just his in-progress ones -- same eligibility taskActionPoll already
  // used for a task-bound transfer tap.
  assert.deepEqual(first.choices.options.map(o => o.label), ['مهمة مقترحة', 'لوحة', 'تسليم التقرير']);
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  const tapped = await f.run(tap(first.choices.id, reportOption.id), neverAsk);
  assert.equal(tapped.status, 'applied', 'a transfer request needs no extra field, so the tap alone must be enough to file it');
  const approval = f.db.prepare("SELECT entity_id AS entityId FROM approvals WHERE type='task_transfer'").get();
  assert.equal(approval.entityId, B);
  const f2 = fixture(t); const r2 = await f2.run({ text: 'مش مسؤوليتي' });
  assert.equal(r2.status, 'clarify'); assert.ok(r2.choices);
});
test('a bare comment phrase ("اضافة ملاحظة"/"عندي تحديث") with two eligible tasks polls, and tapping it asks for the missing note text', async t => {
  const f = fixture(t);
  const first = await f.run({ text: 'اضافة ملاحظة' });
  assert.equal(first.status, 'clarify'); assert.ok(first.choices);
  const tapped = await f.run(tap(first.choices.id, first.choices.options[0].id), neverAsk);
  // No note text was ever typed -- executeManagementAction's own comment
  // validation asks for it, exactly as it already does for the model-driven
  // path when the model itself extracts no body text.
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /التعليق مطلوب/);
  const f2 = fixture(t); const r2 = await f2.run({ text: 'عندي تحديث' });
  assert.equal(r2.status, 'clarify'); assert.ok(r2.choices);
});
test('a longer sentence that merely contains one of the trigger words is left for the model, never intercepted', async t => {
  const f = fixture(t);
  let asked = false;
  const r = await f.run({ text: 'بخبرك لما انهاء المهمة يصير اليوم المسا' }, async () => { asked = true; return emptySecretaryIntent('clarify', 'تمام'); });
  assert.ok(asked, 'a longer sentence must still reach the model, not the deterministic bare-phrase shortcut');
  assert.equal(r.status, 'clarify');
});
test('the same bare phrase addressed to the secretary in the team group is left alone -- a group message always needs "سكرتير" in it, so it never equals a bare trigger phrase exactly', async t => {
  const f = fixture(t);
  let asked = false;
  const r = await f.run({ text: 'يا سكرتير، انهاء المهمة لو سمحت', groupId: '12345@g.us' }, async () => { asked = true; return emptySecretaryIntent('clarify', 'تمام'); });
  assert.ok(asked, 'group messages must never be resolved by the deterministic bare-phrase shortcut');
  void r;
});
