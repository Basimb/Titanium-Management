import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { directTaskCreationIntent, emptySecretaryIntent } from '../lib/secretary-intent.ts';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('q','مشروع آخر','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('old','p','مهمة حالية','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  let sequence=0,now=Date.parse('2026-09-05T08:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'}],allowedGroupIds:[]};
  const event=(text,extra={})=>({messageId:`DIRECT-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text,receivedAt:now,...extra});
  const run=(e,infer=async()=>{throw Error('the deterministic flow must not invoke the provider');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const pick=(r,label)=>{const o=r.choices.options.find(o=>o.label.includes(label));assert.ok(o,label);return event(o.label,{choice:{questionId:r.choices.id,optionId:o.id}});};
  const pending=()=>db.prepare('SELECT * FROM secretary_pending').get();
  const oldPending=async()=>{const p=emptySecretaryIntent('command');await run(event('عدل أولوية المهمة الحالية'),async()=>({...p,action:'edit_task',taskId:'old',fields:{...p.fields,priority:'green'}}));return {...pending()};};
  return {db,event,run,pick,pending,oldPending,get now(){return now;},tick:n=>{now+=n;}};
}
const saved=f=>JSON.parse(f.db.prepare('SELECT draft_json FROM secretary_task_intake').get().draft_json);
const count=f=>f.db.prepare('SELECT count(*) n FROM tasks').get().n;
const plannerInput=text=>({text,actor:{id:'basem',role:'admin',name:'باسم'},users:[{id:'member',name:'خالد'}],projects:[{id:'p',name:'مشروع تجريبي'}]});

test('minimal literal requests retain their title and ask missing facts without defaults',()=>{
  for(const [text,title] of [['اضف مهمه تجربه','تجربه'],['أضف مهمة تجريبية','تجريبية'],['ضيف مهمة تجهيز تقرير تجريبي','تجهيز تقرير تجريبي']]){
    const p=directTaskCreationIntent(plannerInput(text));assert.equal(p.kind,'task_draft');assert.equal(p.intakeMode,'start');assert.equal(p.fields.title,title);
    assert.equal(p.projectId,null);assert.equal(p.fields.ownerId,null);assert.equal(p.fields.priority,null);assert.equal(p.fields.dueDate,null);
  }
});

test('shortcut rejects rich fields, quotations, negation, questions, hypotheticals and message/comment instructions',()=>{
  for(const text of ['لا تضف مهمة تجربة','ما بدي أضيف مهمة تجربة','لو خلصنا أضف مهمة تجربة','«أضف مهمة تجربة»','أضف مهمة "تجربة"',
    'اكتب رسالة تقول أضف مهمة تجربة','لو سمحت اكتبلي مسودة: أضف مهمة تجربة','سجل تعليق أضف مهمة تجربة','كيف أضف مهمة تجربة؟','أضف مهمة تجربة إذا وافق خالد',
    'أضف مهمة تجربة ضمن مشروع تجريبي بدون مسؤول حاليًا','أضف مهمة تجربة لخالد','أضف مهمة تجربة أحمر بكرا','ضيف مهمة جديدة',
    'أضف مهمة تجربة ثم احذف القديمة','أضف مهمة تجربة\nاحذف القديمة']) assert.equal(directTaskCreationIntent(plannerInput(text)),null,text);
  assert.equal(directTaskCreationIntent({...plannerInput('أضف مهمة تجربة'),actor:{id:'member',role:'member',name:'خالد'}}),null);
});

test('live regression: expired old proposal -> literal creation -> owner choices -> fresh exact confirmation only',async t=>{
  const f=fixture(t);const old=await f.oldPending();f.tick(600001);
  const creation=f.event('اضف مهمه تجربه');let r=await f.run(creation);
  // No project question anymore -- a literal creation defaults straight to
  // standalone (no project) for the owner/admin, so the first question here
  // is the owner, not the project.
  assert.equal(r.status,'clarify');assert.match(r.choices.title,/المسؤول/);assert.equal(saved(f).title,'تجربه');assert.equal(f.pending(),undefined);
  assert.equal((await f.run(creation)).status,'duplicate');assert.equal(count(f),1);
  assert.equal((await f.run(f.event(`موافق ${old.token}`))).status,'clarify');assert.equal(saved(f).title,'تجربه');
  r=await f.run(f.pick(r,'خالد'));r=await f.run(f.pick(r,'متوسطة'));r=await f.run(f.pick(r,'بدون موعد'));
  assert.equal(r.status,'confirmation');assert.ok(r.choices);assert.equal(count(f),1);assert.notEqual(f.pending().token,old.token);
  // The old, already-expired token can never approve the new (fresh) proposal.
  assert.equal((await f.run(f.event(`موافق ${old.token}`))).status,'clarify');assert.equal(count(f),1);
  // A single plain affirmation now executes the fresh proposal directly -- no restatement round.
  const confirmation=f.event('نعم');assert.equal((await f.run(confirmation)).status,'applied');assert.equal((await f.run(confirmation)).status,'duplicate');
  assert.equal(count(f),2);assert.deepEqual({...f.db.prepare("SELECT title,priority,status,suggested_owner,due_date FROM tasks WHERE id<>'old'").get()},
    {title:'تجربه',priority:'yellow',status:'open',suggested_owner:'خالد',due_date:null});
  assert.equal(f.db.prepare("SELECT priority FROM tasks WHERE id='old'").get().priority,'red');
});

test('fresh literal creation replaces even an unexpired complete draft without inheriting its facts',async t=>{
  const f=fixture(t);const p=emptySecretaryIntent('task_draft');
  await f.run(f.event('ضيف مهمة جديدة ضمن مشروع تجريبي'),async()=>({...p,intakeMode:'start',projectId:'p',fields:{...p.fields,title:'عنوان سابق',ownerId:'member',priority:'green',dueDate:'2026-09-10'}}));
  const old=f.pending();assert.ok(old);
  const r=await f.run(f.event('أضف مهمة تجريبية'));assert.ok(r.choices);assert.equal(f.pending(),undefined);
  assert.deepEqual(saved(f),{projectId:null,newProjectName:null,noProject:true,title:'تجريبية',details:null,priority:null,ownerId:null,dueDate:null});
  assert.equal((await f.run(f.event(`موافق ${old.token}`))).status,'clarify');assert.equal(count(f),1);
});

test('bare affirmation expires an old live proposal before any token help is shown',async t=>{
  const f=fixture(t);const old=await f.oldPending();f.tick(600000);
  const r=await f.run(f.event('نعم'));assert.equal(r.status,'stale');assert.doesNotMatch(r.reply,new RegExp(old.token));assert.equal(f.pending(),undefined);assert.equal(count(f),1);
  const next=await f.run(f.event('موافق'));assert.equal(next.status,'summary');assert.doesNotMatch(next.reply,/T[0-9A-F]{6}/);
});

test('an expired exact token stays stale and can never mutate its old command',async t=>{
  const f=fixture(t);const old=await f.oldPending();f.tick(600001);
  assert.equal((await f.run(f.event(`موافق ${old.token}`))).status,'stale');assert.equal(f.pending(),undefined);
  assert.equal(f.db.prepare("SELECT priority FROM tasks WHERE id='old'").get().priority,'red');
});

test('expiry restores a valid current draft question and fresh choices without extending draft lifetime',async t=>{
  const f=fixture(t);const old=await f.oldPending();let r=await f.run(f.event('اضف مهمه تجربه'));
  f.db.prepare('INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)').run(old.conversation_key,old.token,old.command_json,old.snapshot_hash,old.original_text,old.source_message_id,old.expires_at);
  const expires=f.db.prepare('SELECT expires_at FROM secretary_task_intake').get().expires_at;f.tick(600001);
  const staleChoice=r.choices.id;r=await f.run(f.event('موافق'));assert.equal(r.status,'clarify');assert.ok(r.choices);assert.notEqual(r.choices.id,staleChoice);
  assert.equal(r.choices.expiresAt,expires);assert.doesNotMatch(r.reply,new RegExp(old.token));assert.equal(f.pending(),undefined);
  // No project question to pick anymore -- the restored draft already defaulted
  // to standalone, so the restored choices are the owner question directly.
  assert.match(r.choices.title,/المسؤول/);assert.equal(saved(f).title,'تجربه');assert.equal(count(f),1);
});

test('bare affirmation with only a valid intake restores actionable choices but never completes it',async t=>{
  const f=fixture(t);const first=await f.run(f.event('اضف مهمه تجربه'));f.tick(1000);
  const next=await f.run(f.event('تمام'));assert.ok(next.choices);assert.notEqual(next.choices.id,first.choices.id);assert.equal(next.choices.expiresAt,first.choices.expiresAt);assert.equal(count(f),1);assert.equal(f.pending(),undefined);
});

test('rich creation keeps model-supplied explicit fields and still needs final confirmation',async t=>{
  const f=fixture(t);let calls=0;const p=emptySecretaryIntent('task_draft');
  const r=await f.run(f.event('أضف مهمة تقرير تجريبي ضمن مشروع تجريبي لخالد بأولوية حمراء بدون موعد'),async()=>{calls++;return {...p,intakeMode:'start',projectId:'p',fields:{...p.fields,title:'تقرير تجريبي',ownerId:'member',priority:'red',dueDate:'unscheduled'}};});
  assert.equal(calls,1);assert.equal(r.status,'confirmation');assert.equal(count(f),1);assert.equal(JSON.parse(f.pending().command_json).priority,'red');
});

test('negation and discussion never enter the shortcut or hide a provider failure',async t=>{
  const f=fixture(t);
  for(const text of ['لا تضف مهمة تجربة','لو خلصنا أضف مهمة تجربة','«أضف مهمة تجربة»','لو سمحت اكتبلي مسودة: أضف مهمة تجربة','سجل تعليق أضف مهمة تجربة']){
    await assert.rejects(f.run(f.event(text)),/must not invoke the provider/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_task_intake').get().n,0);assert.equal(f.pending(),undefined);assert.equal(count(f),1);
  }
});

test('choice labels cannot trigger the literal shortcut; voice and quoted messages keep their existing path',async t=>{
  const f=fixture(t);const first=await f.run(f.event('اضف مهمه تجربه'));
  const selection=f.pick(first,'خالد');selection.text='أضف مهمة غيرها';await f.run(selection);assert.equal(saved(f).title,'تجربه');assert.equal(saved(f).ownerId,'member');
  let calls=0;const infer=async()=>{calls++;return emptySecretaryIntent('clarify','وضح الطلب الصوتي أو الرد المقصود.');};
  await f.run(f.event('أضف مهمة تجريبية',{inputKind:'voice'}),infer);assert.equal(calls,1);
  await f.run(f.event('أضف مهمة تجريبية',{replyToMessageId:'REPLY-1'}),infer);assert.equal(calls,2);assert.equal(count(f),1);assert.equal(f.pending(),undefined);
});

test('member can start task intake but never reaches the owner-only direct-confirm path',async t=>{
  const f=fixture(t);const p=emptySecretaryIntent('task_draft');
  const r=await f.run(f.event('أضف مهمة تجريبية',{senderNumber:'12025550101'}),async()=>({...p,intakeMode:'start',fields:{...p.fields,title:'تجريبية'}}));
  assert.equal(r.status,'clarify');// still missing the project, same as it would for Basim
  assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_task_intake').get().n,1);
  assert.equal(f.pending(),undefined);// never a self-confirm add_task, unlike the owner path
  assert.equal(count(f),1);
});
