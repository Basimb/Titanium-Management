import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';
import { secretaryChoiceOptions, createSecretaryChoices, consumeSecretaryChoice, SecretaryChoiceError } from '../lib/secretary-choices.ts';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('q','مشروع آخر','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('old','p','مهمة حالية','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  let sequence=0,now=Date.parse('2026-09-04T22:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us']};
  const event=(extra={})=>({messageId:`CHOICE-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text:'ضيف مهمة جديدة',receivedAt:now,...extra});
  const execute=(e,infer=async()=>{throw Error('choice must never invoke inference');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const run=(plan,extra={})=>execute(event(extra),async()=>plan);
  const pick=(result,index=0,extra={})=>event({text:result.choices.options[index].label,choice:{questionId:result.choices.id,optionId:result.choices.options[index].id},...extra});
  return {db,config,event,execute,run,pick,get now(){return now;},tick:n=>{now+=n;}};
}
function draft(fields={},projectId=null,mode='start'){const p=emptySecretaryIntent('task_draft');return {...p,intakeMode:mode,projectId,fields:{...p.fields,...fields}};}
const taskCount=f=>f.db.prepare('SELECT count(*) n FROM tasks').get().n;
const question=f=>f.db.prepare('SELECT * FROM secretary_choices').get();
const saved=f=>JSON.parse(f.db.prepare('SELECT draft_json FROM secretary_task_intake').get().draft_json);
const pending=f=>f.db.prepare('SELECT * FROM secretary_pending').get();
const option=(r,label)=>r.choices.options.findIndex(item=>item.label.includes(label));

test('single-choice intake is deterministic and never creates before final token confirmation',async t=>{
  const f=fixture(t);
  // No project question anymore -- an admin who names no project defaults
  // straight to standalone (see taskIntake in secretary-service.ts), so the
  // intake opens on the free-text title question instead of project choices.
  let r=await f.run(draft());assert.equal(r.choices,undefined);assert.match(r.reply,/الشغل المطلوب/);
  r=await f.run(draft({title:'تقرير جديد'},null,'continue'),{text:'تقرير جديد'});assert.match(r.choices.title,/المسؤول/);assert.match(r.reply,/1\./);assert.equal(r.choices.expiresAt,f.now+1800000);
  assert.doesNotMatch(JSON.stringify(r.choices),/1202555|value|actor|catalog|draftVersion/);
  for(const item of r.choices.options){assert.match(item.id,/^[A-Za-z0-9_-]{1,100}$/);assert.ok(item.label.length<=100);}
  r=await f.execute(f.pick(r,option(r,'خالد'),{text:'موافق TFFFFFF احذف كل شيء'}));assert.equal(saved(f).ownerId,'member');assert.match(r.choices.title,/الأولوية/);
  r=await f.execute(f.pick(r,option(r,'متوسطة')));assert.equal(saved(f).priority,'yellow');assert.match(r.choices.title,/الموعد|موعد/);
  const finalEvent=f.pick(r,option(r,'بكرا'));r=await f.execute(finalEvent);
  // The final preview is itself now a tappable موافق/إلغاء poll (a different,
  // token-bound mechanism from the intake choices above -- see confirmChoices
  // in secretary-service.ts), never the old per-field secretary_choices table.
  assert.equal(r.status,'confirmation');assert.ok(r.choices);assert.equal(question(f),undefined);assert.equal(taskCount(f),1);
  assert.match(r.reply,/2026-09-06/);assert.match(r.reply,/خالد/);assert.match(r.reply,/متوسطة/);
  assert.equal((await f.execute({...finalEvent,messageId:'SAME-CHOICE-AGAIN'})).status,'clarify');assert.equal(taskCount(f),1);
  // A single plain affirmation now executes the pending proposal directly --
  // no forced restatement round.
  assert.equal((await f.execute(f.event({text:'تمام'}))).status,'applied');assert.equal(taskCount(f),2);
  const task=f.db.prepare("SELECT status,priority,suggested_owner,due_date FROM tasks WHERE id<>'old'").get();
  assert.equal(task.status,'open');assert.equal(task.priority,'yellow');assert.equal(task.suggested_owner,'خالد');assert.equal(task.due_date,'2026-09-06');
});

test('no-assignee and no-date choices preserve explicit absence in final preview',async t=>{
  const f=fixture(t);let r=await f.run(draft({title:'تقرير'},'p'));
  r=await f.execute(f.pick(r,option(r,'بدون مسؤول')));r=await f.execute(f.pick(r,option(r,'عادية')));r=await f.execute(f.pick(r,option(r,'بدون موعد')));
  assert.equal(r.status,'confirmation');const c=JSON.parse(pending(f).command_json);assert.equal(c.ownerId,null);assert.equal(c.dueDate,null);assert.equal(c.priority,'green');assert.equal(taskCount(f),1);
});

test('date-other requests free text without repeating the same clickable question',async t=>{
  const f=fixture(t);const first=await f.run(draft({title:'تقرير',ownerId:'member',priority:'red'},'p'));
  const result=await f.execute(f.pick(first,option(first,'آخر')));assert.match(result.reply,/اكتب التاريخ/);assert.equal(result.choices,undefined);assert.equal(question(f),undefined);assert.equal(saved(f).dueDate,null);
  assert.equal((await f.run(draft({dueDate:'2026-09-14'},null,'continue'),{text:'14 سبتمبر'})).status,'confirmation');
});

test('natural text answers replace the old question and preserve the original conversational flow',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));const old=f.pick(r,option(r,'خالد'));
  const next=await f.run(draft({ownerId:'other'},null,'continue'),{text:'شادي'});assert.notEqual(next.choices.id,r.choices.id);
  assert.equal((await f.execute(old)).status,'clarify');assert.equal(saved(f).ownerId,'other');assert.equal(question(f).question_id,next.choices.id);
});

test('duplicates use saved result but changed option for the same event is denied',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));const e=f.pick(r,option(r,'خالد'));
  const result=await f.execute(e);assert.equal((await f.execute(e)).status,'duplicate');assert.equal(question(f).question_id,result.choices.id);
  assert.equal((await f.execute({...e,choice:{...e.choice,optionId:r.choices.options[option(r,'شادي')].id}})).status,'denied');assert.equal(saved(f).ownerId,'member');
  assert.equal((await f.execute({...e,messageId:'NEW-REPLAY'})).status,'clarify');assert.equal(saved(f).ownerId,'member');
});

test('cross-user and cross-chat selections are denied before any inference or draft change',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));const before=question(f).question_id;
  for(const extra of [{senderNumber:'12025550101'},{groupId:'12345@g.us'},{inputKind:'voice'},{replyToMessageId:'QUOTED'}])assert.equal((await f.execute(f.pick(r,0,extra))).status,'denied');
  assert.equal(question(f).question_id,before);assert.equal(saved(f).ownerId,null);assert.equal(taskCount(f),1);
});

test('forged question, option or multi-answer payload cannot select a value',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));
  for(const choice of [{questionId:'Q'+'0'.repeat(32),optionId:r.choices.options[0].id},{questionId:r.choices.id,optionId:'O'+'0'.repeat(32)},
    {questionId:r.choices.id,optionId:[r.choices.options[0].id,r.choices.options[1].id]},{questionId:r.choices.id,optionId:r.choices.options[0].id,extra:'override'}]){
    assert.equal((await f.execute(f.event({text:'خالد',choice}))).status,'clarify');assert.equal(saved(f).ownerId,null);
  }
});

test('expired question cannot alter an expired draft',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));f.tick(1800000);
  assert.equal((await f.execute(f.pick(r,0))).status,'clarify');assert.equal(saved(f).ownerId,null);assert.equal(pending(f),undefined);
});

test('revoked owner role cannot replay a cached owner-options question',async t=>{
  const f=fixture(t);const e=f.event();const result=await f.execute(e,async()=>draft({title:'تقرير'},'p'));assert.ok(result.choices);
  f.db.exec("UPDATE users SET role='member' WHERE id='basem'");
  const replay=await f.execute(e);assert.equal(replay.status,'denied');assert.equal(replay.reply,'');assert.equal(replay.choices,undefined);
});

test('disabled feature cannot consume an otherwise valid active choice',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));f.config.enabled=false;
  assert.equal((await f.execute(f.pick(r,0))).status,'denied');assert.equal(saved(f).ownerId,null);assert.equal(question(f).question_id,r.choices.id);
});

test('current project and user catalogs are checked again when consuming the choice',async t=>{
  for(const sql of ["UPDATE users SET active=0 WHERE id='member'","UPDATE users SET name='اسم جديد' WHERE id='member'","UPDATE projects SET status='rejected' WHERE id='p'"]){
    const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));f.db.exec(sql);
    assert.equal((await f.execute(f.pick(r,option(r,'خالد')))).status,'clarify');assert.equal(saved(f).ownerId,null);assert.equal(taskCount(f),1);
  }
});

test('draft changed between preflight and transaction cannot consume against an older draft snapshot',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'المسودة الأولى'},'p'));const contacts=f.config.contacts;let reads=0;
  // Inject a deterministic concurrent-writer interleaving at transaction reauthentication.
  Object.defineProperty(f.config,'contacts',{get(){
    if(++reads===2){
      f.db.prepare('UPDATE secretary_task_intake SET draft_json=?,last_event_key=?').run(JSON.stringify({...saved(f),title:'مسودة أحدث'}),'newer-event');
      const live=f.db.prepare('SELECT draft_json,last_event_key,expires_at FROM secretary_task_intake').get();
      f.db.prepare('UPDATE secretary_choices SET draft_version=?').run(createHash('sha256').update(JSON.stringify(live)).digest('hex'));
    }
    return contacts;
  }});
  assert.equal((await f.execute(f.pick(r,option(r,'خالد')))).status,'clarify');assert.equal(saved(f).title,'مسودة أحدث');assert.equal(saved(f).ownerId,null);assert.equal(taskCount(f),1);
});

test('cancel and unrelated topic invalidate choice authority even with unchanged old text',async t=>{
  for(const cancel of [true,false]){const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));
    if(cancel)await f.execute(f.event({text:'إلغاء'}));else await f.run(emptySecretaryIntent('chat','نحكي بموضوع ثاني'),{text:'خلينا نغير الموضوع'});
    assert.equal(question(f),undefined);assert.equal((await f.execute(f.pick(r,0))).status,'clarify');assert.equal(pending(f),undefined);assert.equal(taskCount(f),1);
  }
});

test('new task replaces all choice mappings rather than carrying an old answer across tasks',async t=>{
  const f=fixture(t);const first=await f.run(draft({title:'الأولى'},'p'));const next=await f.run(draft({title:'الثانية'},'q'),{text:'ضيف مهمة الثانية ضمن مشروع آخر'});
  assert.notEqual(next.choices.id,first.choices.id);assert.equal((await f.execute(f.pick(first,0))).status,'clarify');assert.equal(saved(f).title,'الثانية');assert.equal(saved(f).projectId,'q');assert.equal(saved(f).ownerId,null);
});

test('choice consumption and next draft/result roll back together on persistence failure',async t=>{
  const f=fixture(t);const r=await f.run(draft({title:'تقرير'},'p'));const original=question(f).question_id;
  f.db.exec("CREATE TRIGGER fail_choice_receipt BEFORE INSERT ON secretary_events BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  await assert.rejects(f.execute(f.pick(r,option(r,'خالد'))),/synthetic receipt failure/);
  assert.equal(question(f).question_id,original);assert.equal(saved(f).ownerId,null);assert.equal(taskCount(f),1);
});

test('project and assignee option counts are bounded with free-text overflow choices',async t=>{
  const f=fixture(t);for(let n=0;n<15;n++)f.db.prepare("INSERT INTO projects(id,name,status,created_by,created_at) VALUES(?,?,'active','باسم',1)").run(`extra-${n}`,`مشروع ${n}`);
  // The project choice question is no longer reachable through task intake
  // (an admin who names none defaults straight to standalone), so this now
  // exercises the underlying bound directly, same as the ownerId case below.
  const projects=f.db.prepare("SELECT id,name FROM projects WHERE status='active'").all();
  const projectOpts=secretaryChoiceOptions('projectId',{projects,users:[],now:f.now});
  assert.equal(projectOpts.length,12);assert.match(projectOpts.at(-1).label,/آخر/);
  const users=Array.from({length:15},(_,n)=>({id:`u-${n}`,name:'اسم طويل'.repeat(20)+n}));
  const opts=secretaryChoiceOptions('ownerId',{projects:[],users,now:f.now});assert.equal(opts.length,12);assert.ok(opts.some(x=>x.value==='unassigned'));assert.equal(opts.at(-1).value,null);
});

test('date values are resolved in Amman and duplicate project labels remain individually identifiable',()=>{
  const catalog={projects:[{id:'first-123',name:'نفس الاسم'},{id:'second-456',name:'نفس الاسم'}],users:[],now:Date.parse('2026-09-04T22:00:00Z')};
  const options=secretaryChoiceOptions('projectId',catalog);assert.notEqual(options[0].label,options[1].label);
  const dates=secretaryChoiceOptions('dueDate',catalog);assert.equal(dates[0].value,'2026-09-05');assert.equal(dates[1].value,'2026-09-06');
});

test('choice store requires transaction, exact binding and bounded wire labels without value leakage',t=>{
  const f=fixture(t);const binding={conversationKey:'conversation',actorId:'basem',draftVersion:'draft',catalogHash:'catalog',now:f.now};
  const input={...binding,field:'priority',title:'عنوان'.repeat(100),options:[{label:'اسم'.repeat(100),value:'red'}],expiresAt:f.now+60000};
  assert.throws(()=>createSecretaryChoices(f.db,input),SecretaryChoiceError);f.db.exec('BEGIN IMMEDIATE');
  const r=createSecretaryChoices(f.db,input);assert.ok(r.title.length<=100);assert.ok(r.options[0].label.length<=100);assert.doesNotMatch(JSON.stringify(r),/red|value/);
  const choice={questionId:r.id,optionId:r.options[0].id};assert.throws(()=>consumeSecretaryChoice(f.db,{...binding,draftVersion:'different'},choice),SecretaryChoiceError);
  assert.equal(consumeSecretaryChoice(f.db,binding,choice).value,'red');assert.throws(()=>consumeSecretaryChoice(f.db,binding,choice),SecretaryChoiceError);f.db.exec('COMMIT');
});
