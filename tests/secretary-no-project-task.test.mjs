import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';
import { executeManagementAction } from '../lib/management-actions.ts';

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
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('q','مشروع ثان','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('existing','p','مهمة حالية','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let sequence=0, now=1788580000000;
  const event=(extra={})=>({messageId:`NOPROJ-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text:'ضيف مهمة جديدة',receivedAt:now,...extra});
  const execute=(e,infer)=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const run=(plan,extra={},infer)=>execute(event(extra),infer||(async()=>{if(!plan)throw Error('must not call inference');return plan;}));
  return {db,config,event,execute,run,get now(){return now;},tick:n=>{now+=n;}};
}
function draft(fields={},projectId=null,mode='start') { const p=emptySecretaryIntent('task_draft');return {...p,intakeMode:mode,projectId,fields:{...p.fields,...fields}}; }
const complete = {title:'تجهيز تقرير تجريبي',ownerId:'member',priority:'red',dueDate:'2026-09-12'};
const pending = f=>f.db.prepare('SELECT * FROM secretary_pending').get();
const projects = f=>f.db.prepare('SELECT * FROM projects ORDER BY created_at,id').all();
const tasks = f=>f.db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();
const outbox = f=>f.db.prepare('SELECT to_user AS toUser, text FROM agent_outbox ORDER BY id').all();
const basem = { id:'basem', name:'باسم', role:'admin', active:1 };

// One combined "start" plan carrying every answer already, plus the no_project
// sentinel -- same shortcut secretary-task-intake.test.mjs's "all facts in one
// request" test uses, just for setup brevity in the tests below.
async function createStandaloneTaskViaChat(f, overrides={}) {
  const preview = await f.run(draft({...complete,...overrides},'no_project'));
  const token = pending(f).token;
  const result = await f.run(undefined,{text:`موافق ${token}`});
  return { preview, result };
}

test('an admin who never names a project is never asked -- the task opens standalone by default',async t=>{
  const f=fixture(t);
  // No "بأي مشروع؟" question at all, and no tappable project choices either --
  // an unspecified project now defaults straight to "no project" for Basim/admin
  // instead of blocking the draft on a question (see taskIntake in
  // secretary-service.ts). He can still name a real or brand-new project any
  // turn; that always wins over this default (see the noProjectChoice/recent
  // project handling above it).
  const first=await f.run(draft());
  assert.match(first.reply,/الشغل المطلوب/);
  assert.equal(first.choices,undefined,'no project choices are offered since the question never comes up');
  assert.match((await f.run(draft({title:complete.title},null,'continue'),{text:complete.title})).reply,/مين بدك/);
  assert.match((await f.run(draft({ownerId:'member'},null,'continue'),{text:'لخالد'})).reply,/أولويتها/);
  assert.match((await f.run(draft({priority:'red'},null,'continue'),{text:'حمرا'})).reply,/شو موعدها/);
  const preview=await f.run(draft({dueDate:complete.dueDate},null,'continue'),{text:complete.dueDate});
  assert.equal(preview.status,'confirmation');
  assert.doesNotMatch(preview.reply,/المشروع/,'no project line at all -- the concept is invisible to him');
  assert.match(preview.reply,new RegExp(complete.title));
  assert.equal(tasks(f).length,1,'nothing created before confirmation');
});

test('an admin naming a real project on the first turn still uses it instead of defaulting to standalone',async t=>{
  const f=fixture(t);
  const first=await f.run(draft({},'p'),{text:'ضيف مهمة على مشروع تجريبي'});
  assert.match(first.reply,/الشغل المطلوب/);
  const preview=await f.run(draft(complete,null,'continue'),{text:`${complete.title} لخالد حمرا ${complete.dueDate}`});
  assert.equal(preview.status,'confirmation');
  assert.doesNotMatch(preview.reply,/المشروع/,'project is never named in the preview even when one was picked internally');
  const created=await f.run(undefined,{text:`موافق ${pending(f).token}`});
  assert.equal(tasks(f).find(row=>row.id!=='existing').project_id,'p','the real project is still used under the hood');
});

test('confirming a "بدون مشروع" draft creates exactly one wrapper project and one task, with a plain single-task reply',async t=>{
  const f=fixture(t);
  const before=projects(f).length;
  const {result}=await createStandaloneTaskViaChat(f);
  assert.equal(result.status,'applied');
  assert.match(result.reply,/^✅ أضفت مهمة:/);
  assert.match(result.reply,new RegExp(complete.title));
  // Reads like an ordinary single-task confirmation -- no project mention at all.
  assert.doesNotMatch(result.reply,/مشروع/);
  const after=projects(f);
  assert.equal(after.length,before+1,'exactly one new project');
  const wrapper=after.find(p=>p.name==='بدون مشروع');
  assert.ok(wrapper,'a project literally named "بدون مشروع" was created');
  assert.equal(wrapper.is_standalone,1);
  const created=tasks(f).find(row=>row.id!=='existing');
  assert.ok(created,'exactly one new task');
  assert.equal(created.project_id,wrapper.id);
  assert.equal(created.title,complete.title);
  assert.equal(created.suggested_owner,'خالد');
  assert.equal(created.priority,'red');
  assert.equal(created.due_date,complete.dueDate);
  assert.equal(created.status,'open');
  // No group notice about a new project (or anything else) for this path.
  assert.equal(outbox(f).length,0);
});

test('a non-admin who reaches "بدون مشروع" gets a clear decline instead of a silent project',async t=>{
  const f=fixture(t);
  const result=await f.run(draft({title:'مهمة خاصة'},'no_project','start'),{senderNumber:'12025550101',text:'ضيف مهمة بدون مشروع'});
  assert.equal(result.status,'clarify');
  assert.match(result.reply,/باسم فقط/);
  assert.equal(projects(f).length,2,'no wrapper project created');
  assert.equal(tasks(f).length,1,'no task created');
});

test('approving the last open task in a normal project archives it automatically, with no message to Basim',async t=>{
  const f=fixture(t);
  const before=outbox(f).length;
  f.db.exec("UPDATE tasks SET status='approval' WHERE id='existing'");
  const approved=executeManagementAction(f.db,basem,{action:'approve',taskId:'existing'},{now:f.now});
  assert.ok(f.db.prepare("SELECT archived_at FROM projects WHERE id='p'").get().archived_at,'a real project auto-archives once its last task is done');
  assert.match(approved.message,/وأُغلق تلقائيًا مشروع «مشروع تجريبي»/);
  assert.equal(outbox(f).length,before,'no close-suggestion is sent -- it just closes');
});

test('a project with multiple open tasks does not auto-archive when only one of them is approved',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO tasks(id,project_id,title,details,priority,status,owner,suggested_owner,created_at,updated_at) VALUES('extra','p','مهمة اضافية','','yellow','open',NULL,'خالد',1,1)").run();
  f.db.exec("UPDATE tasks SET status='approval' WHERE id='existing'");
  executeManagementAction(f.db,basem,{action:'approve',taskId:'existing'},{now:f.now});
  assert.equal(outbox(f).filter(r=>r.toUser==='basem').length,0);
  assert.equal(f.db.prepare("SELECT archived_at FROM projects WHERE id='p'").get().archived_at,null);
});

test('approving the last task of a "بدون مشروع" wrapper project archives it automatically with no message to Basim',async t=>{
  const f=fixture(t);
  const {result}=await createStandaloneTaskViaChat(f);
  const wrapper=projects(f).find(p=>p.name==='بدون مشروع');
  const created=tasks(f).find(row=>row.id!==('existing')&&row.project_id===wrapper.id);
  f.db.prepare("UPDATE tasks SET status='approval' WHERE id=?").run(created.id);
  const before=outbox(f).length;
  const approved=executeManagementAction(f.db,basem,{action:'approve',taskId:created.id},{now:f.now});
  assert.match(approved.message,/وأُغلق تلقائيًا المشروع المؤقت/);
  assert.ok(f.db.prepare('SELECT archived_at FROM projects WHERE id=?').get(wrapper.id).archived_at,'the wrapper project is archived');
  assert.equal(outbox(f).length,before,'no message asking Basim anything');
  void result;
});
