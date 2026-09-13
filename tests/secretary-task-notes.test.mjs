// Basim (2026-09-13): "بدي ينعرض اخر ملاحظتين فقط على كل ائمة «شو مهامي» (المهام
// مرقّمة) و كرت المهمة داخل القائمة و كرت مهمة وحدة لما تسأل عنها بالاسم و إشعار
// الغروب لما حدا يضيف ملاحظة" -- notes lived only on the dashboard: a numbered
// list showed none and gave no hint a task even had any, a named task's card
// showed only the single newest one, and the group notice carried just the note
// being added with no thread around it. All four now carry the newest two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary, secretaryTaskCard } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('t','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL);
    INSERT INTO comments (task_id,author,body,created_at) VALUES
      ('t','أيمن','أقدم ملاحظة ما لازم تظهر',100),
      ('t','شادي','جهزت الكشف وبعتته',200),
      ('t','خالد','حكيت مع النقابة اليوم',300);`);
  migrateSecretary(db);
  const config = { enabled:true, sharedKey:'ab'.repeat(32), contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let count = 0, now = 1788580000000;
  const event = (extra={}) => ({ messageId:`EVENT-${++count}`,senderNumber:'12025550101',groupId:null,text:'شو مهامي؟',receivedAt:now,responseMessageId:`REPLY-${count}`, ...extra });
  const run = (plan=emptySecretaryIntent('summary'),extra={},infer) => handleSecretaryEvent(db,event(extra),config,{ infer:infer || (async()=>plan),now:()=>now });
  return {db,run,get now(){return now;}};
}
const outbox = db => db.prepare('SELECT to_user AS toUser, text FROM agent_outbox ORDER BY id').all();
const snapshot = (comments) => ({ tasks:[], users:[], comments });
const TASK = { id:'t',title:'لوحة',details:'',priority:'red',status:'progress',owner:'خالد',suggestedOwner:'خالد',startedAt:1,dueDate:null,completedAt:null,rejectionReason:null,createdAt:1,updatedAt:1,archivedAt:null,archivedBy:null };

test('a task card carries the newest two notes, never a third, in a list and on its own alike', () => {
  const state = snapshot([
    { taskId:'t',author:'خالد',body:'حكيت مع النقابة اليوم',createdAt:300 },
    { taskId:'t',author:'شادي',body:'جهزت الكشف وبعتته',createdAt:200 },
    { taskId:'t',author:'أيمن',body:'أقدم ملاحظة ما لازم تظهر',createdAt:100 }]);
  for (const detailed of [false, true]) {
    const card = secretaryTaskCard(TASK, state, 1788580000000, detailed);
    assert.match(card, /خالد: حكيت مع النقابة اليوم/, 'the newest note shows');
    assert.match(card, /شادي: جهزت الكشف وبعتته/, 'the one before it shows too');
    assert.doesNotMatch(card, /أقدم ملاحظة/, 'the third-newest note must never show');
  }
});

test('a task with no notes gains no note lines in a list, and keeps its empty-state line on its own card', () => {
  const empty = snapshot([]);
  const inList = secretaryTaskCard(TASK, empty, 1788580000000);
  assert.doesNotMatch(inList, /↳|لا يوجد تحديث/, 'a list must not gain a noise line per note-less task');
  assert.match(secretaryTaskCard(TASK, empty, 1788580000000, true), /لا يوجد تحديث مسجّل بعد/);
});

test('notes of one task never leak onto another task’s card', () => {
  const state = snapshot([{ taskId:'other-task',author:'شادي',body:'ملاحظة على مهمة ثانية',createdAt:400 }]);
  assert.doesNotMatch(secretaryTaskCard(TASK, state, 1788580000000, true), /ملاحظة على مهمة ثانية/);
});

test('the numbered «شو مهامي» list shows each task’s newest two notes', async t => {
  const f = fixture(t);
  const result = await f.run(emptySecretaryIntent('summary'));
  assert.equal(result.status, 'summary');
  assert.match(result.reply, /خالد: حكيت مع النقابة اليوم/);
  assert.match(result.reply, /شادي: جهزت الكشف وبعتته/);
  assert.doesNotMatch(result.reply, /أقدم ملاحظة/);
});

test('the group notice for a new note carries the note before it, not just the one added', async t => {
  const f = fixture(t);
  const plan = { ...emptySecretaryIntent('command'), action:'comment', taskId:'t',
    fields:{ ...emptySecretaryIntent('command').fields, body:'وصلني رد النقابة' } };
  const applied = await f.run(plan, { text:'علّق: وصلني رد النقابة' });
  assert.equal(applied.status, 'applied');
  const group = outbox(f.db).find(row => row.toUser === 'group' && /علّق على/.test(row.text));
  assert.ok(group, 'the group still gets the comment notice');
  assert.match(group.text, /وصلني رد النقابة/, 'the note just added');
  assert.match(group.text, /خالد: حكيت مع النقابة اليوم/, 'and the one before it');
  assert.doesNotMatch(group.text, /جهزت الكشف/, 'never a third');
});

test('the group team-reminder post carries each task’s newest two notes', async t => {
  const f = fixture(t);
  const plan = { ...emptySecretaryIntent('command'), action:'team_reminders', taskId:null };
  // team_reminders is actor-bound-confirmation gated like every broadcast.
  const asked = await f.run(plan, { senderNumber:'12025550103', text:'ابعت تذكير المهام الآن' });
  assert.equal(asked.status, 'confirmation');
  const token = f.db.prepare('SELECT * FROM secretary_pending').get().token;
  const sent = await f.run(undefined, { senderNumber:'12025550103', text:`موافق ${token}` });
  assert.equal(sent.status, 'applied');
  const group = outbox(f.db).find(row => row.toUser === 'group' && /تذكير بالمهام المفتوحة/.test(row.text));
  assert.ok(group, 'the group still gets the per-owner reminder post');
  assert.match(group.text, /خالد: حكيت مع النقابة اليوم/, 'the newest note shows on the group post');
  assert.match(group.text, /شادي: جهزت الكشف وبعتته/, 'and the one before it');
  assert.doesNotMatch(group.text, /أقدم ملاحظة/, 'never a third');
  // The same lines go to the owner privately -- one formatter feeds both.
  const priv = outbox(f.db).find(row => row.toUser === 'member' && /تذكير بمهامك الحالية/.test(row.text));
  assert.match(priv.text, /خالد: حكيت مع النقابة اليوم/);
});

test('the management report listing carries notes under each task', async t => {
  const f = fixture(t);
  const report = await f.run(emptySecretaryIntent('report'), { senderNumber:'12025550103', text:'ملخص مهام الفريق' });
  assert.equal(report.status, 'summary');
  assert.match(report.reply, /خالد: حكيت مع النقابة اليوم/);
  assert.match(report.reply, /شادي: جهزت الكشف وبعتته/);
  assert.doesNotMatch(report.reply, /أقدم ملاحظة/);
});
