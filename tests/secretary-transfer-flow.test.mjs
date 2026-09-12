// Basim's second report, batched with secretary-clarify-fuzzy-fallback.test.mjs's
// fix: "وفيه تكلمه بعد طلب تحويل المهمه المفروض يعطيني تصويت باسماء الموظفين
// و اضيف ملاحظه غصب مشان نعرف سبب التحويل" -- after a task-transfer request,
// (1) he wants a real tappable poll of employee names to pick the transfer
// target instead of relying on free-text name parsing, and (2) a reason is
// now mandatory before any transfer request reaches him, so his decision is
// never blind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const A = '22222222-2222-4222-8222-222222222222';
const C = '44444444-4444-4444-8444-444444444444';

function fixture(t, { colleagues = true, secondTask = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1)
      ${colleagues ? `,('other','شادي','member',1,NULL,1,1),('third','أيمن','member',1,NULL,1,1)` : ''};
    INSERT INTO tasks VALUES('${A}','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL)
      ${secondTask ? `,('${C}','تسليم التقرير','','yellow','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL)` : ''};`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }, { userId: 'third', number: '12025550104' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (plan, extra = {}) => handleSecretaryEvent(db, event(extra), config, { infer: async () => plan, now: () => now });
  const tap = (questionId, optionId, extra = {}) => handleSecretaryEvent(db, event({ choice: { questionId, optionId }, ...extra }), config, { infer: async () => { throw new Error('a poll tap must resolve directly, never ask the model'); }, now: () => now });
  return { db, config, event, run, tap, now };
}
function transferPlan({ ownerId = null, reason = null } = {}) {
  const base = emptySecretaryIntent('task_transfer_request');
  return { ...base, taskId: A, fields: { ...base.fields, ownerId, reason } };
}

test('task_transfer_request with a named colleague but no reason asks for the reason before filing anything', async t => {
  const f = fixture(t);
  const r = await f.run(transferPlan({ ownerId: 'other' }), { text: 'حول اللوحة لشادي' });
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /سبب/);
  assert.match(r.reply, /لوحة/);
  assert.equal(r.taskId, A);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0, 'nothing filed before the reason is known');
});

test('task_transfer_request with both a named colleague and a reason files directly, no poll needed', async t => {
  const f = fixture(t);
  const r = await f.run(transferPlan({ ownerId: 'other', reason: 'بالإجازة الأسبوع الجاي' }), { text: 'حول اللوحة لشادي لأني بالإجازة' });
  assert.equal(r.status, 'applied');
  assert.match(r.reply, /رفعت طلب التحويل/);
  const approval = f.db.prepare("SELECT payload FROM approvals WHERE type='task_transfer'").get();
  const payload = JSON.parse(approval.payload);
  assert.equal(payload.suggestedOwnerName, 'شادي');
  assert.equal(payload.reason, 'بالإجازة الأسبوع الجاي');
});

test('task_transfer_request with a reason but no colleague named offers a real tappable poll of active colleagues, excluding the actor and Basim', async t => {
  const f = fixture(t);
  const r = await f.run(transferPlan({ reason: 'مشغول بمهمة ثانية' }), { text: 'بدي احول اللوحة لأني مشغول بمهمة ثانية' });
  assert.equal(r.status, 'clarify');
  assert.ok(r.choices, 'must offer a real poll, not a plain-text "who exactly" question');
  assert.deepEqual(new Set(r.choices.options.map(o => o.label)), new Set(['شادي', 'أيمن', 'بدون تحديد - مش مسؤوليتي']));
  assert.equal(r.choices.options.at(-1).label, 'بدون تحديد - مش مسؤوليتي', 'the decline option must be last');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

test('tapping a colleague on the transfer poll files the request against that colleague, carrying the already-collected reason through', async t => {
  const f = fixture(t);
  const first = await f.run(transferPlan({ reason: 'مشغول بمهمة ثانية' }), { text: 'بدي احول اللوحة لأني مشغول بمهمة ثانية' });
  const aymanOption = first.choices.options.find(o => o.label === 'أيمن');
  const tapped = await f.tap(first.choices.id, aymanOption.id);
  assert.equal(tapped.status, 'applied');
  const approval = f.db.prepare("SELECT payload FROM approvals WHERE type='task_transfer'").get();
  const payload = JSON.parse(approval.payload);
  assert.equal(payload.suggestedOwnerName, 'أيمن');
  assert.equal(payload.reason, 'مشغول بمهمة ثانية');
  // The poll is single-use.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n, 0);
});

test('tapping "بدون تحديد - مش مسؤوليتي" on the transfer poll files the decline with no suggested owner, and never re-opens the same poll', async t => {
  const f = fixture(t);
  const first = await f.run(transferPlan({ reason: 'مش قسمي أصلًا' }), { text: 'مش مسؤوليتي، بس شو السبب اسأل عني' });
  const declineOption = first.choices.options.find(o => o.label === 'بدون تحديد - مش مسؤوليتي');
  const tapped = await f.tap(first.choices.id, declineOption.id);
  assert.equal(tapped.status, 'applied');
  assert.match(tapped.reply, /مش مسؤوليتك/);
  const approval = f.db.prepare("SELECT payload FROM approvals WHERE type='task_transfer'").get();
  const payload = JSON.parse(approval.payload);
  assert.equal(payload.suggestedOwnerId, null);
  assert.equal(payload.reason, 'مش قسمي أصلًا');
});

test('with no active colleagues to offer, a reason-only transfer request files the decline directly instead of showing an empty poll', async t => {
  const f = fixture(t, { colleagues: false });
  const r = await f.run(transferPlan({ reason: 'ما في حدا غيري بالفريق' }), { text: 'مش مسؤوليتي' });
  assert.equal(r.status, 'applied');
  assert.equal(r.choices, undefined);
  const approval = f.db.prepare("SELECT payload FROM approvals WHERE type='task_transfer'").get();
  assert.equal(JSON.parse(approval.payload).suggestedOwnerId, null);
});

// 2026-09-12 follow-up, Basim's own live test: with two eligible tasks open,
// typing "تحويل المهمة" (or tapping LGDTRANSFER) correctly offers a real
// poll of the TASKS first (which one?), same as LGDFINISH/LGDNOTE. But
// tapping one used to dead-end exactly like the note bug: the "شو سبب
// التحويل؟" question that follows never remembered which task was just
// picked, so the actor's very next message (the reason itself) went back
// through the model, which (correctly, by design) never trusts its own
// taskId guess once 2+ of the actor's tasks qualify -- so it just reopened
// the same "which task?" poll again, forever. Per Basim: unlike finishing a
// task, he explicitly wants the reason question KEPT for transfers, just
// answered once and carried straight through to the colleague poll and the
// approval he gets -- never re-asked.
test('tapping the deterministic transfer poll (two eligible tasks) asks for the reason naming the tapped task, never the model', async t => {
  const f = fixture(t, { secondTask: true });
  const first = await handleSecretaryEvent(f.db, f.event({ text: 'تحويل المهمة' }), f.config, { infer: async () => { throw new Error('a bare typed legend phrase must resolve deterministically, never ask the model'); }, now: () => f.now });
  assert.equal(first.status, 'clarify');
  assert.ok(first.choices, 'must offer a real tappable poll of the two eligible tasks');
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  const tapped = await f.tap(first.choices.id, reportOption.id);
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /سبب تحويل/);
  assert.match(tapped.reply, /تسليم التقرير/);
  assert.equal(tapped.taskId, C);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0, 'nothing filed before the reason is known');
});

test('the very next plain message after that completes the transfer deterministically -- it never reopens the "which task?" poll, and the reason reaches the colleague poll and the approval', async t => {
  const f = fixture(t, { secondTask: true });
  const first = await handleSecretaryEvent(f.db, f.event({ text: 'تحويل المهمة' }), f.config, { infer: async () => { throw new Error('must not ask the model'); }, now: () => f.now });
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  await f.tap(first.choices.id, reportOption.id);
  const answered = await handleSecretaryEvent(f.db, f.event({ text: 'مشغول بمهمة ثانية' }), f.config, { infer: async () => { throw new Error('the follow-up reason must be captured deterministically, never sent back through the model'); }, now: () => f.now });
  assert.equal(answered.status, 'clarify');
  assert.ok(answered.choices, 'the reason is known now -- it must move straight to the colleague poll, not ask again which task');
  const aymanOption = answered.choices.options.find(o => o.label === 'أيمن');
  const tapped = await f.tap(answered.choices.id, aymanOption.id);
  assert.equal(tapped.status, 'applied');
  const approval = f.db.prepare("SELECT payload FROM approvals WHERE type='task_transfer'").get();
  const payload = JSON.parse(approval.payload);
  assert.equal(payload.suggestedOwnerName, 'أيمن');
  assert.equal(payload.reason, 'مشغول بمهمة ثانية');
  assert.equal(payload.taskTitle, 'تسليم التقرير');
});

test('explicitly cancelling instead of supplying the transfer reason drops the pending follow-up cleanly', async t => {
  const f = fixture(t, { secondTask: true });
  const first = await handleSecretaryEvent(f.db, f.event({ text: 'تحويل المهمة' }), f.config, { infer: async () => { throw new Error('must not ask the model'); }, now: () => f.now });
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  await f.tap(first.choices.id, reportOption.id);
  const cancelled = await handleSecretaryEvent(f.db, f.event({ text: 'الغاء' }), f.config, { infer: async () => { throw new Error('a cancellation must resolve directly, never ask the model'); }, now: () => f.now });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_note_followup').get().n, 0, 'the follow-up row must not linger after cancellation');
});
