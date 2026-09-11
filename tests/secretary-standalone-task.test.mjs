import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';
import { executeManagementAction } from '../lib/management-actions.ts';

// Projects were removed from the product entirely: a task is a flat, standalone
// record. This file used to cover the "بدون مشروع" hack that faked a hidden
// wrapper project to satisfy tasks.project_id NOT NULL -- what it described is
// now simply how EVERY task is created, so the same expectations live on here
// against the real, single creation path. The one behaviour that deliberately
// changed: that old path never called dispatchManagementNotice, so a task
// created through chat notified nobody. It goes through the ordinary add_task
// path now, so the owner gets their normal claim poll and the group its notice.

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('existing','مهمة حالية','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let sequence=0, now=1788580000000;
  const event=(extra={})=>({messageId:`NOPROJ-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text:'ضيف مهمة جديدة',receivedAt:now,...extra});
  const execute=(e,infer)=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const run=(plan,extra={},infer)=>execute(event(extra),infer||(async()=>{if(!plan)throw Error('must not call inference');return plan;}));
  return {db,config,event,execute,run,get now(){return now;},tick:n=>{now+=n;}};
}
function draft(fields={},mode='start') { const p=emptySecretaryIntent('task_draft');return {...p,intakeMode:mode,fields:{...p.fields,...fields}}; }
const complete = {title:'تجهيز تقرير تجريبي',ownerId:'member',priority:'red',dueDate:'2026-09-12'};
const pending = f=>f.db.prepare('SELECT * FROM secretary_pending').get();
const tasks = f=>f.db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();
const outbox = f=>f.db.prepare('SELECT to_user AS toUser, text, choices_json AS choicesJson FROM agent_outbox ORDER BY id').all();
const basem = { id:'basem', name:'باسم', role:'admin', active:1 };

// One combined "start" plan carrying every answer already -- same shortcut
// secretary-task-intake.test.mjs's "all facts in one request" test uses, just
// for setup brevity in the tests below.
async function createTaskViaChat(f, overrides={}) {
  const preview = await f.run(draft({...complete,...overrides}));
  const token = pending(f).token;
  const result = await f.run(undefined,{text:`موافق ${token}`});
  return { preview, result };
}

test('the creation questionnaire never asks about a project and never mentions one',async t=>{
  const f=fixture(t);
  const first=await f.run(draft());
  assert.match(first.reply,/الشغل المطلوب/,'the very first question is the work itself');
  assert.doesNotMatch(first.reply,/مشروع/);
  assert.equal(first.choices,undefined,'no project choices are offered since the question never comes up');
  assert.match((await f.run(draft({title:complete.title},'continue'),{text:complete.title})).reply,/مين بدك/);
  assert.match((await f.run(draft({ownerId:'member'},'continue'),{text:'لخالد'})).reply,/أولويتها/);
  assert.match((await f.run(draft({priority:'red'},'continue'),{text:'حمرا'})).reply,/شو موعدها/);
  const preview=await f.run(draft({dueDate:complete.dueDate},'continue'),{text:complete.dueDate});
  assert.equal(preview.status,'confirmation');
  assert.doesNotMatch(preview.reply,/مشروع/,'no project line at all -- the concept does not exist');
  assert.match(preview.reply,new RegExp(complete.title));
  assert.equal(tasks(f).length,1,'nothing created before confirmation');
});

test('confirming the draft creates exactly one standalone task and notifies its owner with the claim poll',async t=>{
  const f=fixture(t);
  const {result}=await createTaskViaChat(f);
  assert.equal(result.status,'applied');
  assert.match(result.reply,/أضاف مهمة/);
  assert.match(result.reply,new RegExp(complete.title));
  assert.doesNotMatch(result.reply,/مشروع/);
  const created=tasks(f).find(row=>row.id!=='existing');
  assert.ok(created,'exactly one new task');
  assert.equal(tasks(f).length,2);
  assert.equal(created.title,complete.title);
  assert.equal(created.suggested_owner,'خالد');
  assert.equal(created.priority,'red');
  assert.equal(created.due_date,complete.dueDate);
  assert.equal(created.status,'open');
  assert.ok(!Object.keys(created).includes('project_id'),'the task row has no project column at all');
  // The old wrapper-project path silently skipped notifications entirely. It
  // goes through the ordinary add_task pipeline now, so the group hears about
  // it and the new owner gets a real tappable claim poll.
  const queue=outbox(f);
  const group=queue.find(row=>row.toUser==='group');
  assert.ok(group,'the group gets the standard new-task notice');
  assert.match(group.text,/🆕 مهمة جديدة/);
  assert.match(group.text,new RegExp(complete.title));
  assert.doesNotMatch(group.text,/مشروع/);
  const owner=queue.find(row=>row.toUser==='member'&&/تحديث على مهمتك/.test(row.text));
  assert.ok(owner,'the assigned employee is told privately');
  assert.match(owner.choicesJson,new RegExp(`TSK${created.id}CLAIM`),'and can tap to claim it');
  assert.equal(queue.filter(row=>row.toUser==='basem').length,0,'Basim created it himself -- no self-notice');
});

// The recently-fixed "let an admin who creates or reassigns a task to himself
// get the claim poll" behaviour has to survive the unified create path: a
// handoff still delivers the poll even when the new owner IS the actor.
test('an admin creating a task for himself still gets his own claim poll',async t=>{
  const f=fixture(t);
  await createTaskViaChat(f,{ownerId:'basem'});
  const created=tasks(f).find(row=>row.id!=='existing');
  const own=outbox(f).find(row=>row.toUser==='basem'&&/تحديث على مهمتك/.test(row.text));
  assert.ok(own,'the handoff exception still applies to himself');
  assert.match(own.choicesJson,new RegExp(`TSK${created.id}CLAIM`));
});

test('a task opened with no assignee notifies the group only, and nobody privately',async t=>{
  const f=fixture(t);
  await createTaskViaChat(f,{ownerId:'unassigned'});
  const created=tasks(f).find(row=>row.id!=='existing');
  assert.equal(created.suggested_owner,null);
  const queue=outbox(f);
  assert.equal(queue.filter(row=>row.toUser==='group').length,1);
  assert.match(queue.find(row=>row.toUser==='group').text,/غير معيّنة/);
  assert.equal(queue.filter(row=>row.toUser!=='group').length,0,'nobody to hand it to yet');
});

// Employees may open a task too; it is filed for Basim's decision rather than
// created directly -- and the old "فتح مهمة بدون مشروع متاح لباسم فقط" decline
// is gone along with projects.
test('an employee opening a task files one request for Basim instead of being declined',async t=>{
  const f=fixture(t);
  const result=await f.run(draft({title:'مهمة خاصة',priority:'yellow',dueDate:'unscheduled'}),{senderNumber:'12025550101',text:'ضيف مهمة جديدة'});
  assert.equal(result.status,'applied');
  assert.match(result.reply,/رفعت طلبك لباسم/);
  assert.doesNotMatch(result.reply,/مشروع/);
  assert.equal(tasks(f).length,1,'nothing is created before Basim decides');
  const approval=f.db.prepare('SELECT type,summary,payload FROM approvals').get();
  assert.equal(approval.type,'task_create');
  assert.match(approval.summary,/فتح مهمة «مهمة خاصة»/);
  assert.doesNotMatch(approval.payload,/project/i);
});

test('approving a task closes exactly that task, with nothing else closing alongside it',async t=>{
  const f=fixture(t);
  await createTaskViaChat(f);
  const created=tasks(f).find(row=>row.id!=='existing');
  f.db.prepare("UPDATE tasks SET status='approval' WHERE id=?").run(created.id);
  const approved=executeManagementAction(f.db,basem,{action:'approve',taskId:created.id},{now:f.now});
  assert.match(approved.message,/اعتمد إنجاز المهمة/);
  assert.match(approved.message,/وأُرشفت تلقائيًا/);
  assert.doesNotMatch(approved.message,/مشروع/,'nothing above the task exists to auto-close');
  assert.ok(f.db.prepare('SELECT archived_at FROM tasks WHERE id=?').get(created.id).archived_at);
  assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='existing'").get().status,'progress','a sibling task is untouched');
});
