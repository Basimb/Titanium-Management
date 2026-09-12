// Basim's exact repro: he typed "ضيف ملاحظه" (add a note) meaning to add a
// note to one of his in-progress tasks, and got a plain-text "which task?"
// question instead of a tappable poll ("قصدي ما فتح تصويت" -- I mean, no
// poll opened). Root cause: "ضيف ملاحظه" doesn't match any of
// LEGEND_TYPED_PHRASES' own exact wordings (those require "بدي اضيف
// ملاحظة"), so it reached the model, which itself gave up with a generic
// "clarify" instead of returning close_request/task_transfer_request/a
// comment command with a best-guess taskId (the documented exception in
// secretary-intent.ts's own prompt). legendFuzzyPhraseOption catches this:
// a short, non-negated "clarify" that still plainly names one of the three
// self-service actions by a bare keyword now gets the SAME real poll
// legendCandidates/taskChoicePoll already give the exact typed phrase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

function fixture(t, { secondTask = true } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('${A}','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL)
      ${secondTask ? `,('${B}','تسليم التقرير','','yellow','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL)` : ''};`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550101', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (text, modelReply, extra = {}) => handleSecretaryEvent(db, event({ text, ...extra }), config, { infer: async () => modelReply, now: () => now });
  return { db, config, event, run, now };
}
const genericClarify = (text) => emptySecretaryIntent('clarify', text);

test('a bare-keyword "clarify" the model gave up on ("ضيف ملاحظه", Basim\'s own words) gets a real tappable poll when several tasks qualify', async t => {
  const f = fixture(t);
  const r = await f.run('ضيف ملاحظه', genericClarify('أين تود إضافة الملاحظة بالضبط؟ يمكنني إضافة تعليق على إحدى المهام المدرجة، أي واحد منها تحديداً؟'));
  assert.equal(r.status, 'clarify');
  assert.ok(r.choices, 'must offer a real tappable poll, not the model\'s own plain question');
  assert.deepEqual(r.choices.options.map(o => o.label), ['لوحة', 'تسليم التقرير']);
});

test('tapping that fallback poll adds the note to the tapped task once the text is supplied', async t => {
  const f = fixture(t);
  const first = await f.run('ضيف ملاحظه', genericClarify('أي مهمة تقصد؟'));
  const reportOption = first.choices.options.find(o => o.label === 'تسليم التقرير');
  const tapped = await handleSecretaryEvent(f.db, f.event({ choice: { questionId: first.choices.id, optionId: reportOption.id } }), f.config,
    { infer: async () => { throw new Error('a poll tap must resolve directly, never ask the model'); }, now: () => f.now });
  // No note text was ever typed -- executeManagementAction's own comment
  // validation asks for it next, exactly like the pre-existing exact-typed-
  // phrase path already does for the same situation.
  assert.equal(tapped.status, 'clarify');
  assert.match(tapped.reply, /التعليق مطلوب/);
  // Basim hit this live (2026-09-12): this reply used to drop task focus
  // entirely (no taskId, empty scope), so his very next message -- whether
  // it was the missing note text or something unrelated -- got treated as a
  // fresh, contextless message (a generic greeting) instead of a
  // continuation of this exact outstanding request. The reported-on task
  // must stay in focus, exactly like the single-candidate fallback already
  // preserves it in its own "تقصد مهمة «..»؟ اكتب نص الملاحظة." reply.
  assert.equal(tapped.taskId, B);
});

test('with exactly one eligible task, the fallback asks a single grounded question naming that task instead of a poll', async t => {
  const f = fixture(t, { secondTask: false });
  const r = await f.run('خلص المهمة', genericClarify('أي مهمة تقصد إنهاءها بالضبط؟'));
  assert.equal(r.status, 'clarify');
  assert.equal(r.choices, undefined);
  assert.match(r.reply, /لوحة/);
  assert.equal(r.taskId, A);
});

test('with zero eligible tasks, the fallback gives the legend\'s own "no task" reply instead of the model\'s generic question', async t => {
  const f = fixture(t);
  const r = await f.run('حول المهمة', genericClarify('لمين بدك تحول؟'), { senderNumber: '12025550103' }); // Basim himself owns no in-progress task as a worker here
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عندك مهمة/);
  assert.equal(r.choices, undefined);
});

test('a longer sentence that merely mentions one of the trigger words in passing is left exactly as the model answered', async t => {
  const f = fixture(t);
  const modelReply = 'وضحلي بجملة وحدة شو بالضبط بدك تنفذ على المهمة.';
  const r = await f.run('بخبرك إذا صار في تحديث على الملاحظة يلي حكينا عنها قبل شوي بخصوص العميل', genericClarify(modelReply));
  assert.equal(r.status, 'clarify');
  assert.equal(r.reply, modelReply, 'a long sentence must never be intercepted, even if it contains one of the bare keywords');
  assert.equal(r.choices, undefined);
});

test('a negated statement the model still answered with "clarify" is left alone rather than risking the opposite action', async t => {
  const f = fixture(t);
  const modelReply = 'قصدك لسا ما خلصت، ولا خلصت جزء منها؟';
  const r = await f.run('لسا ما خلصت المهمة', genericClarify(modelReply));
  assert.equal(r.status, 'clarify');
  assert.equal(r.reply, modelReply);
  assert.equal(r.choices, undefined);
});

test('a "command" comment with no taskId at all (never even a guess) also gets the same real poll, not a downstream crash or dead end', async t => {
  const f = fixture(t);
  const base = emptySecretaryIntent('command');
  const plan = { ...base, action: 'comment', taskId: null, fields: { ...base.fields, body: 'العميل وافق على العرض' } };
  const r = await f.run('اضافة تعليق ان العميل وافق على العرض', plan);
  assert.equal(r.status, 'clarify');
  assert.ok(r.choices, 'must offer a real poll instead of failing downstream on a missing taskId');
  assert.deepEqual(r.choices.options.map(o => o.label), ['لوحة', 'تسليم التقرير']);
});
