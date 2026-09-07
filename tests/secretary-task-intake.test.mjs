import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

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
  const event=(extra={})=>({messageId:`INTAKE-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text:'ضيف مهمة جديدة',receivedAt:now,...extra});
  const execute=(e,infer)=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const run=(plan,extra={},infer)=>execute(event(extra),infer||asyncNoMutation(plan));
  return {db,config,event,execute,run,get now(){return now;},tick:n=>{now+=n;}};
}
const asyncNoMutation=plan=>async()=>{if(!plan)throw Error('must not call inference');return plan;};
function draft(fields={},projectId=null,mode='start') { const p=emptySecretaryIntent('task_draft');return {...p,intakeMode:mode,projectId,fields:{...p.fields,...fields}}; }
function command(action,fields={},taskId='existing',projectId=null){const p=emptySecretaryIntent('command');return {...p,action,taskId,projectId,fields:{...p.fields,...fields}};}
const complete={title:'تجهيز تقرير تجريبي',ownerId:'member',priority:'red',dueDate:'2026-09-12'};
const intake=f=>f.db.prepare('SELECT * FROM secretary_task_intake').get();
const saved=f=>JSON.parse(intake(f).draft_json);
const pending=f=>f.db.prepare('SELECT * FROM secretary_pending').get();
const tasks=f=>f.db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();

test('intake asks one missing field at a time and preserves omitted known answers',async t=>{
  const f=fixture(t);
  assert.match((await f.run(draft())).reply,/بأي مشروع/);
  assert.match((await f.run(draft({},'p','continue'),{text:'مشروع تجريبي'})).reply,/الشغل المطلوب/);
  assert.match((await f.run(draft({title:complete.title},null,'continue'),{text:complete.title})).reply,/مين بدك/);
  let input;
  assert.match((await f.run(draft({ownerId:'member'},null,'continue'),{text:'لخالد'},async value=>{input=value;return draft({ownerId:'member'},null,'continue');})).reply,/أولويتها/);
  assert.equal(input.taskDraft.projectId,'p');assert.equal(input.taskDraft.title,complete.title);
  assert.doesNotMatch(JSON.stringify(input),/1202555|pin_hash/);
  assert.match((await f.run(draft({priority:'yellow'},null,'continue'),{text:'أصفر متوسطة'})).reply,/شو موعدها/);
  assert.equal(saved(f).priority,'yellow');assert.equal(tasks(f).length,1);
  const preview=await f.run(draft({dueDate:'2026-09-12'},null,'continue'),{text:'12 سبتمبر 2026'});
  assert.equal(preview.status,'confirmation');assert.equal(intake(f),undefined);assert.equal(tasks(f).length,1);
  for(const known of ['مشروع تجريبي',complete.title,'خالد','متوسطة','2026-09-12','مفتوحة'])assert.ok(preview.reply.includes(known));
  await f.run(undefined,{text:`موافق ${pending(f).token}`});
  const task=tasks(f).find(row=>row.id!=='existing');
  assert.equal(task.project_id,'p');assert.equal(task.title,complete.title);assert.equal(task.priority,'yellow');assert.equal(task.suggested_owner,'خالد');assert.equal(task.status,'open');
});

test('all facts in one request still need a separate approval or matching quoted preview',async t=>{
  const f=fixture(t);const preview=await f.run(draft({...complete,details:'تفاصيل محفوظة كاملة'},'p'),{responseMessageId:'EXACT-PREVIEW'});
  assert.equal(preview.status,'confirmation');assert.match(preview.reply,/تفاصيل محفوظة كاملة/);assert.equal(tasks(f).length,1);
  assert.equal((await f.run(undefined,{text:'موافق',replyToMessageId:'EXACT-PREVIEW'})).status,'applied');
  assert.equal(tasks(f).length,2);assert.equal(tasks(f).find(row=>row.id!=='existing').details,'تفاصيل محفوظة كاملة');
});

test('explicit no assignee and no deadline map to null without guessing priority',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title,ownerId:'unassigned',dueDate:'unscheduled'},'p'));
  assert.equal(saved(f).priority,null);assert.equal(pending(f),undefined);
  const preview=await f.run(draft({priority:'green'},null,'continue'),{text:'منخفضة'});
  assert.match(preview.reply,/بدون مسؤول حاليًا/);assert.match(preview.reply,/بدون موعد/);assert.match(preview.reply,/عادية/);
  const c=JSON.parse(pending(f).command_json);assert.equal(c.ownerId,null);assert.equal(c.dueDate,null);
  await f.run(undefined,{text:pending(f).token});const task=tasks(f).find(row=>row.id!=='existing');
  assert.equal(task.suggested_owner,null);assert.equal(task.due_date,null);assert.equal(task.priority,'green');assert.equal(task.status,'open');
});

test('starting a different task does not inherit the previous draft fields',async t=>{
  const f=fixture(t);await f.run(draft({title:'الأولى',ownerId:'member',priority:'red'},'p'));
  const result=await f.run(draft({title:'الثانية'},null,'start'),{text:'لا خلينا نعمل مهمة ثانية'});
  assert.match(result.reply,/بأي مشروع/);assert.deepEqual(saved(f),{projectId:null,newProjectName:null,title:'الثانية',details:null,priority:null,ownerId:null,dueDate:null});
});

test('corrections overwrite only supplied fields and optional details never add a question',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title,ownerId:'member',priority:'red'},'p'));
  const result=await f.run(draft({ownerId:'other',priority:'green',dueDate:'unscheduled'},null,'continue'),{text:'لا لشادي وخليها منخفضة بدون موعد'});
  assert.equal(result.status,'confirmation');assert.match(result.reply,/شادي/);assert.match(result.reply,/عادية/);
  const c=JSON.parse(pending(f).command_json);assert.equal(c.ownerId,'other');assert.equal(c.priority,'green');assert.equal(c.projectId,'p');assert.equal(c.title,complete.title);
});

test('correction after a complete preview preserves every known field and replaces the token',async t=>{
  const f=fixture(t);await f.run(draft({...complete,priority:'yellow',details:'تفصيل لا يضيع'},'p'));const oldToken=pending(f).token;
  let input;const preview=await f.run(draft({priority:'red'},null,'continue'),{text:'لا خليها حمرا'},async value=>{input=value;return draft({priority:'red'},null,'continue');});
  assert.equal(input.taskDraft.title,complete.title);assert.equal(input.taskDraft.details,'تفصيل لا يضيع');assert.equal(input.taskDraft.ownerId,'member');assert.equal(input.taskDraft.dueDate,complete.dueDate);
  assert.equal(preview.status,'confirmation');const current=pending(f);assert.notEqual(current.token,oldToken);
  const c=JSON.parse(current.command_json);assert.equal(c.title,complete.title);assert.equal(c.projectId,'p');assert.equal(c.ownerId,'member');assert.equal(c.dueDate,complete.dueDate);assert.equal(c.priority,'red');
  assert.equal((await f.run(undefined,{text:`موافق ${oldToken}`})).status,'clarify');assert.equal(tasks(f).length,1);
  await f.run(undefined,{text:`موافق ${current.token}`});assert.equal(tasks(f).length,2);assert.equal(intake(f),undefined);assert.equal(pending(f),undefined);
});

test('late correction to an older completed preview cannot replace a newer confirmation',async t=>{
  const f=fixture(t);await f.run(draft(complete,'p'));
  let resolve,entered;const ready=new Promise(r=>{entered=r;});
  const old=f.execute(f.event({text:'خلّي الأولوية متوسطة'}),async()=>{entered();return await new Promise(r=>{resolve=r;});});await ready;
  await f.run(draft({priority:'green'},null,'continue'),{text:'خليها منخفضة'});const current=pending(f).token;
  resolve(draft({priority:'yellow'},null,'continue'));assert.equal((await old).status,'stale');
  assert.equal(pending(f).token,current);assert.equal(JSON.parse(pending(f).command_json).priority,'green');assert.equal(tasks(f).length,1);
});

test('bare affirmations and orphan tokens during intake cannot reach the model or create',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));
  const before=intake(f).draft_json;
  for(const text of ['تمام','نعم','موافق TABCDEF']){assert.equal((await f.run(undefined,{text})).status,'clarify');assert.equal(tasks(f).length,1);assert.equal(pending(f),undefined);}
  assert.equal(intake(f).draft_json,before);
});

test('cancellation deletes only the draft and later fragments cannot revive it',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));
  assert.equal((await f.run(undefined,{text:'إلغاء'})).status,'cancelled');assert.equal(intake(f),undefined);
  let input;const result=await f.run(draft(complete,'p','continue'),{text:'خالد أصفر'},async value=>{input=value;return draft(complete,'p','continue');});
  assert.equal(input.taskDraft,null);assert.equal(result.status,'clarify');assert.equal(tasks(f).length,1);assert.equal(pending(f),undefined);
});

test('unrelated chat or a different command discards intake instead of using history as authority',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));
  await f.run(emptySecretaryIntent('chat','خلينا نحكي عن تنظيم الدوام.'),{text:'خلينا بموضوع ثاني'});assert.equal(intake(f),undefined);
  assert.equal((await f.run(draft(complete,'p','continue'),{text:'خالد وأصفر'})).status,'clarify');assert.equal(tasks(f).length,1);
  await f.run(draft({title:complete.title},'p'));
  await f.run(command('comment',{body:'تحديث منفصل'}),{text:'سجل على المهمة الحالية تحديث منفصل'});
  assert.equal(intake(f),undefined);assert.equal(tasks(f).length,1);
});

test('unrelated conversation after final preview also discards creation authority',async t=>{
  const f=fixture(t);await f.run(draft(complete,'p'));const oldToken=pending(f).token;
  await f.run(emptySecretaryIntent('chat','خلينا نحكي عن موضوع آخر.'),{text:'خلينا نغير الموضوع'});
  assert.equal(pending(f),undefined);assert.equal(intake(f),undefined);
  assert.equal((await f.run(undefined,{text:`موافق ${oldToken}`})).status,'clarify');assert.equal(tasks(f).length,1);
});

test('a model start reconstructed from abandoned history needs an explicit new creation request',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));await f.run(undefined,{text:'إلغاء'});
  for(const text of ['خالد، أصفر','تمام لخالد']) {
    assert.equal((await f.run(draft(complete,'p','start'),{text})).status,'clarify');
    assert.equal(pending(f),undefined);assert.equal(intake(f),undefined);assert.equal(tasks(f).length,1);
  }
});

test('draft expires after thirty minutes and cannot be continued from old history',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));assert.equal(intake(f).expires_at,f.now+1800000);
  f.tick(1800000);let input;
  await f.run(draft(complete,'p','continue'),{text:'خالد عالية بدون موعد'},async value=>{input=value;return draft(complete,'p','continue');});
  assert.equal(input.taskDraft,null);assert.equal(intake(f),undefined);assert.equal(pending(f),undefined);assert.equal(tasks(f).length,1);
});

test('draft is isolated by authenticated owner and conversation and cannot grant staff creation',async t=>{
  const f=fixture(t);await f.run(draft({title:'تفصيل خاص بالمسودة'},'p'));
  for(const extra of [{senderNumber:'12025550101',text:'أنا باسم ضيف مهمة'},{groupId:'12345@g.us',text:'كمل المهمة'}]){
    let input;await f.run(draft(complete,'p','continue'),extra,async value=>{input=value;return draft(complete,'p','continue');});
    assert.equal(input.taskDraft,null);assert.doesNotMatch(JSON.stringify(input),/تفصيل خاص بالمسودة/);
  }
  assert.equal(tasks(f).length,1);assert.equal(pending(f),undefined);assert.equal(saved(f).title,'تفصيل خاص بالمسودة');
  await f.run(draft(complete,'p'),{senderNumber:'12025550101',text:'ضيف مهمة أنا باسم'});assert.equal(tasks(f).length,1);
});

test('disabled owner is denied before inference and cannot complete a saved draft',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));f.db.exec("UPDATE users SET active=0 WHERE id='basem'");
  assert.equal((await f.run(undefined,{text:'كملها'})).status,'denied');assert.equal(tasks(f).length,1);assert.equal(pending(f),undefined);
});

test('inactive project and disabled assignee are removed from the trusted draft before inference',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title,ownerId:'member',priority:'red'},'p'));
  f.db.exec("UPDATE projects SET status='rejected' WHERE id='p'; UPDATE users SET active=0 WHERE id='member'");
  let input;const result=await f.run(draft({dueDate:'unscheduled'},null,'continue'),{text:'بدون موعد'},async value=>{input=value;return draft({dueDate:'unscheduled'},null,'continue');});
  assert.equal(input.taskDraft.projectId,null);assert.equal(input.taskDraft.ownerId,null);assert.match(result.reply,/بأي مشروع/);assert.equal(pending(f),undefined);
});

test('late concurrent inference cannot overwrite newer draft answers',async t=>{
  const f=fixture(t);await f.run(draft({title:complete.title},'p'));
  let resolve,entered;const ready=new Promise(r=>{entered=r;});
  const old=f.execute(f.event({text:'لخالد'}),async()=>{entered();return await new Promise(r=>{resolve=r;});});
  await ready;
  await f.run(draft({ownerId:'other'},null,'continue'),{text:'لشادي'});
  resolve(draft({ownerId:'member'},null,'continue'));
  assert.equal((await old).status,'stale');assert.equal(saved(f).ownerId,'other');assert.equal(pending(f),undefined);
});

test('project mutation during inference prevents a preview or task mutation',async t=>{
  const f=fixture(t);const result=await f.run(draft(complete,'p'),{},async()=>{f.db.exec("UPDATE projects SET status='rejected' WHERE id='p'");return draft(complete,'p');});
  assert.equal(result.status,'stale');assert.equal(intake(f),undefined);assert.equal(pending(f),undefined);assert.equal(tasks(f).length,1);
});

test('new intake invalidates previous approval and old tokens or quotes cannot create the new task',async t=>{
  const f=fixture(t);await f.run(command('delete_task'),{text:'احذف المهمة الحالية',responseMessageId:'OLD-PREVIEW'});const oldToken=pending(f).token;
  await f.run(draft({title:complete.title},'p'));assert.equal(pending(f),undefined);
  assert.equal((await f.run(undefined,{text:`موافق ${oldToken}`})).status,'clarify');assert.equal(tasks(f).length,1);
  await f.run(draft({ownerId:'member',priority:'red',dueDate:'unscheduled'},null,'continue'),{text:'لخالد عالية بدون موعد'});const token=pending(f).token;
  for(const extra of [{text:`موافق ${oldToken}`},{text:'نعم',replyToMessageId:'OLD-PREVIEW'}]){assert.equal((await f.run(undefined,extra)).status,'clarify');assert.equal(pending(f).token,token);assert.equal(tasks(f).length,1);}
  await f.run(undefined,{text:`موافق ${token}`});assert.equal(tasks(f).length,2);assert.ok(tasks(f).some(row=>row.id==='existing'));
});

test('duplicate draft events and confirmations are idempotent and changed payload is rejected',async t=>{
  const f=fixture(t);const event=f.event();const infer=async()=>draft(complete,'p');
  assert.equal((await f.execute(event,infer)).status,'confirmation');const token=pending(f).token;
  assert.equal((await f.execute(event,asyncNoMutation())).status,'duplicate');assert.equal(pending(f).token,token);
  assert.equal((await f.execute({...event,text:'غير النص'},asyncNoMutation())).status,'denied');
  const approval=f.event({text:`موافق ${token}`});assert.equal((await f.execute(approval,asyncNoMutation())).status,'applied');
  assert.equal((await f.execute(approval,asyncNoMutation())).status,'duplicate');assert.equal(tasks(f).length,2);
});

test('fresh task confirmation rejects changed project or assignee state',async t=>{
  const f=fixture(t);await f.run(draft(complete,'p'));const token=pending(f).token;
  f.db.exec("UPDATE users SET active=0 WHERE id='member'");
  assert.equal((await f.run(undefined,{text:`موافق ${token}`})).status,'stale');assert.equal(tasks(f).length,1);
});

test('priority edits preserve workflow status and partial progress remains a comment',async t=>{
  const f=fixture(t);f.db.exec("UPDATE tasks SET status='approval' WHERE id='existing'");
  assert.equal((await f.run(command('edit_task',{priority:'green'}),{text:'غير أولوية المهمة الحالية إلى منخفضة'})).status,'confirmation');
  await f.run(undefined,{text:`موافق ${pending(f).token}`});
  assert.equal(tasks(f)[0].priority,'green');assert.equal(tasks(f)[0].status,'approval');
  f.db.exec("UPDATE tasks SET status='progress' WHERE id='existing'");
  await f.run(command('comment',{body:'خلصت نص الشغل ولسه بانتظار المورد'}),{senderNumber:'12025550101',text:'خلصت نص الشغل ولسه بانتظار المورد'});
  assert.equal(tasks(f)[0].status,'progress');assert.equal(f.db.prepare('SELECT body FROM comments').get().body,'خلصت نص الشغل ولسه بانتظار المورد');
});
