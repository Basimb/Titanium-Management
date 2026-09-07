import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary, secretaryTaskCard } from '../lib/secretary-service.ts';
import { emptySecretaryIntent, validateSecretaryIntent, inferSecretaryIntent, searchSecretaryWeb } from '../lib/secretary-intent.ts';
import { createSecretaryJobs } from '../lib/secretary-jobs.ts';
import { createSecretaryOutboxJobs, getSecretaryOutboxStatus } from '../lib/secretary-outbox.ts';

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
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('p2','مشروع ثان','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('t','p','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL),
      ('private','p2','مهمة شادي الخاصة','تفاصيل سرية','yellow','progress','شادي','شادي',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled:true, sharedKey:'ab'.repeat(32), contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let count = 0, now = 1788580000000;
  const event = (extra={}) => ({ messageId:`EVENT-${++count}`,senderNumber:'12025550101',groupId:null,text:'شو مهامي؟',receivedAt:now,responseMessageId:`REPLY-${count}`, ...extra });
  const run = (plan=emptySecretaryIntent('summary'),extra={},infer) => handleSecretaryEvent(db,event(extra),config,{ infer:infer || (async()=>plan),now:()=>now });
  return {db,config,event,run,get now(){return now;},tick:n=>{now+=n;}};
}
function command(action,fields={},taskId='t',projectId=null) { const p=emptySecretaryIntent('command');return {...p,action,taskId,projectId,fields:{...p.fields,...fields}}; }
function teamMessage(text='الاجتماع بكرا الساعة 10',recipientIds=['all-team']) { const p=emptySecretaryIntent('message_team');p.fields.body=text;p.recipientIds=recipientIds;return p; }
const pending = db => db.prepare('SELECT * FROM secretary_pending').get();

test('caller identity with projects comes from authenticated sender without model IDs or guessed identity',async t=>{
 const f=fixture(t);
 const result=await f.run(emptySecretaryIntent('chat','إنت مين؟'),{senderNumber:'12025550103',text:'مرحبا، مين أنا وشو المشاريع الموجودة عندنا؟'},async()=>{throw Error('Identity needs no inference');});
 assert.match(result.reply,/أهلًا باسم/);assert.match(result.reply,/مشروع تجريبي/);
 assert.doesNotMatch(result.reply,/ID:|إنت مين|أنا بخير/);
 const member=await f.run(emptySecretaryIntent('chat'),{text:'مين أنا؟'},async()=>{throw Error('No inference');});
 assert.match(member.reply,/أهلًا خالد/);assert.doesNotMatch(member.reply,/أهلًا باسم/);
});

test('owner personal preferences persist privately and can be replaced and forgotten',async t=>{
 const f=fixture(t); const owner={senderNumber:'12025550103'};
 const saved=await f.run(emptySecretaryIntent('chat'),{...owner,text:'احفظ عني: الردود: مختصرة'});
 assert.equal(saved.status,'applied');
 let seen;
 await f.run(emptySecretaryIntent('chat'),{...owner,text:'مرحبا'},async input=>{seen=input;return emptySecretaryIntent('chat','أهلًا');});
 assert.equal(seen.personalContext[0].body,'مختصرة');
 await f.run(emptySecretaryIntent('chat'),{...owner,groupId:'12345@g.us',text:'مرحبا'},async input=>{seen=input;return emptySecretaryIntent('chat','أهلًا');});
 assert.deepEqual(seen.personalContext,[]);
 await f.run(emptySecretaryIntent('chat'),{text:'مرحبا'},async input=>{seen=input;return emptySecretaryIntent('chat','أهلًا');});
 assert.deepEqual(seen.personalContext,[]);
 await f.run(emptySecretaryIntent('chat'),{...owner,text:'انس عني: الردود'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_personal_memory').get().n,0);
});

test('a disputed private answer is recalled across days without turning criticism into an action',async t=>{
 const f=fixture(t); const owner={senderNumber:'12025550103'};
 await f.run(emptySecretaryIntent('chat','اقتراح سابق'),{...owner,text:'كيف أرتب اللوحات؟'});
 await f.run(emptySecretaryIntent('chat','براجعها'),{...owner,text:'جوابك غلط'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_learning_memory').get().n,1);
 f.tick(2*86400000);let seen;
 await f.run(emptySecretaryIntent('chat'),{...owner,text:'كيف أرتب اللوحات؟'},async input=>{seen=input;return emptySecretaryIntent('chat','نراجع التفاصيل');});
 assert.equal(seen.learningMemory.length,1);assert.equal(seen.learningMemory[0].disputedAnswer,'اقتراح سابق');
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});

test('secretary scoped friendly summary has direct link and no foreign data', async t=>{
 const f=fixture(t); const result=await f.run(); assert.equal(result.status,'summary'); assert.match(result.reply,/خالد/);assert.match(result.reply,/🔴 لوحة/);assert.doesNotMatch(result.reply,/https?:\/\/|مهمة شادي|تفاصيل سرية/);
});
test('task card colors are actual priority, never completion or lateness',()=>{
 const state={projects:[{id:'p',name:'مشروع'}],comments:[]};
 for(const [priority,status,dueDate,emoji,label] of [
  ['red','completed',null,'🔴','قصوى'],['green','progress','2020-01-01','🟢','عادية'],['yellow','open',null,'🟡','متوسطة'],
 ]){
  const text=secretaryTaskCard({id:'t',projectId:'p',title:'مهمة',priority,status,dueDate},state,1788580000000);
  assert.ok(text.startsWith('🔵 *مشروع*\n\n'+emoji+' مهمة'));assert.match(text,new RegExp(`الأولوية: ${label}`));
  if(priority==='green')assert.match(text,/متأخرة عن الموعد/);
 }
 assert.ok(secretaryTaskCard({id:'t',priority:'invalid'},state,1788580000000).startsWith('⚪'));
});
test('explicit color lists use DB without inference, exclude archive, and never mutate tasks',async t=>{
 const f=fixture(t);f.db.exec("UPDATE tasks SET status='completed' WHERE id='t'; UPDATE tasks SET priority='green',due_date='2020-01-01' WHERE id='private'");
 const before=JSON.stringify(f.db.prepare('SELECT * FROM tasks ORDER BY id').all());
 const run=text=>f.run(undefined,{text,senderNumber:'12025550103'},async()=>{throw Error('color read must not ask model');});
 const red=await run('اعطيني المهام الحمراء');assert.match(red.reply,/🔴 لوحة/);assert.match(red.reply,/معتمدة/);assert.doesNotMatch(red.reply,/مهمة شادي/);
 const green=await run('وريني المهام الخضراء');assert.match(green.reply,/🟢 مهمة شادي الخاصة/);assert.match(green.reply,/متأخرة عن الموعد/);assert.doesNotMatch(green.reply,/\*لوحة\*/);
 const yellow=await run('بدي المهام الصفراء');assert.match(yellow.reply,/المطابق ضمن صلاحياتك \(دون الأرشيف\): 0/);assert.match(yellow.reply,/ما في مهام تطابق/);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM tasks ORDER BY id').all()),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 f.db.exec("UPDATE tasks SET archived_at=1 WHERE id='t'");assert.match((await run('المهام الحمراء')).reply,/ما في مهام تطابق/);
});
test('priority lists retain member scope and fresh DB facts over incorrect history',async t=>{
 const f=fixture(t);
 await f.run(emptySecretaryIntent('chat','لا توجد مهام حمراء'),{text:'سؤال سابق'});
 const r=await f.run(undefined,{text:'المهام الحمراء'},async()=>{throw Error('must not infer');});
 assert.match(r.reply,/لوحة/);assert.doesNotMatch(r.reply,/شادي|private|تفاصيل سرية/);
 const yellow=await f.run(undefined,{text:'المهام الصفراء'},async()=>{throw Error('must not infer');});assert.match(yellow.reply,/ما في مهام تطابق/);
});
test('priority lists match exact project and current owner qualifiers',async t=>{
 const f=fixture(t);f.db.exec("UPDATE tasks SET priority='red' WHERE id='private'");
 const run=text=>f.run(undefined,{text,senderNumber:'12025550103'},async()=>{throw Error('must not infer');});
 const project=await run('المهام الحمراء في مشروع ثان');assert.match(project.reply,/مهمة شادي/);assert.doesNotMatch(project.reply,/\*لوحة\*/);
 const owner=await run('المهام الحمراء لخالد');assert.match(owner.reply,/لوحة/);assert.doesNotMatch(owner.reply,/مهمة شادي/);
});
test('priority pagination declares counts, stays bounded and preserves every task across pages',async t=>{
 const f=fixture(t);
 const insert=f.db.prepare("INSERT INTO tasks(id,project_id,title,details,priority,status,owner,created_at,updated_at) VALUES(?,'p',?,'','red','open','خالد',1,1)");
 for(let n=1;n<=18;n++)insert.run('page-'+n,'تجربة قائمة '+n);
 const run=text=>f.run(undefined,{text},async()=>{throw Error('must not infer');});
 let text='المهام الحمراء';const seen=new Set();let pages=0;
 for(;;){
  const r=await run(text);pages++;assert.ok(r.reply.length<=3800);assert.match(r.reply,/المطابق ضمن صلاحياتك \(دون الأرشيف\): 19/);
  for(const match of r.reply.matchAll(/^🔴 ((?:لوحة|تجربة قائمة \d+))$/gm)){assert.ok(!seen.has(match[1]));seen.add(match[1]);}
  const next=/للتكملة اكتب: «([^»]+)»/.exec(r.reply);if(!next)break;text=next[1];assert.ok(pages<10);
 }
 assert.equal(seen.size,19);assert.ok(pages>=2);
});
test('model catalog includes priority without task details or contact numbers',async t=>{
 const f=fixture(t);await f.run(undefined,{},async input=>{
  assert.equal(input.tasks[0].priority,'red');assert.doesNotMatch(JSON.stringify(input),/تفاصيل تنفيذ|1202555010/);return emptySecretaryIntent('help');
 });
});
test('explicit status filters are separate from color and extra qualifiers never disappear',async t=>{
 const f=fixture(t);f.db.exec("UPDATE tasks SET priority='red',status='completed' WHERE id='private'");
 const run=text=>f.run(undefined,{text,senderNumber:'12025550103'},async()=>{throw Error('must not infer');});
 const done=await run('المهام الحمراء المعتمدة');assert.match(done.reply,/مهمة شادي/);assert.doesNotMatch(done.reply,/\*لوحة\*/);
 const late=await run('المهام الحمراء المتأخرة');assert.match(late.reply,/لوحة/);assert.doesNotMatch(late.reply,/مهمة شادي/);
 for(const text of ['المهام الحمراء والصفراء','المهام الحمراء بدون مهام خالد','المهام الحمراء اليوم'])assert.equal((await run(text)).status,'clarify');
});
test('continuation removes every accepted page suffix and retains owner/project filters',async t=>{
 const f=fixture(t);const insert=f.db.prepare("INSERT INTO tasks(id,project_id,title,details,priority,status,owner,created_at,updated_at) VALUES(?,'p',?,'','red','open','خالد',1,1)");
 for(let n=1;n<=26;n++)insert.run('page-'+n,'تجربة '+n);
 const run=text=>f.run(undefined,{text,senderNumber:'12025550103'},async()=>{throw Error('must not infer');});
 for(const suffix of ['من رقم 11','ابتداء من 11','من ۱۱']){
  const r=await run('المهام الحمراء في مشروع تجريبي لخالد '+suffix);
  const next=/للتكملة اكتب: «([^»]+)»/.exec(r.reply);assert.ok(next);assert.match(next[1],/^المهام الحمراء في مشروع تجريبي لخالد من \d+$/);
  assert.equal((await run(next[1])).status,'summary');
 }
});
test('bare draft color remains an intake answer while explicit task-color list switches topic',async t=>{
 const f=fixture(t);const owner={senderNumber:'12025550103'};
 await f.run(undefined,{...owner,text:'اضف مهمه تجربه'},async()=>{throw Error('must not infer direct creation');});
 let inferred=false;const plan=emptySecretaryIntent('task_draft');plan.intakeMode='continue';plan.fields.priority='green';
 await f.run(undefined,{...owner,text:'والخضراء؟'},async()=>{inferred=true;return plan;});assert.equal(inferred,true);
 assert.equal(JSON.parse(f.db.prepare('SELECT draft_json FROM secretary_task_intake').get().draft_json).priority,'green');
 const list=await f.run(undefined,{...owner,text:'المهام الحمراء'},async()=>{throw Error('explicit list must not infer');});assert.match(list.reply,/لوحة/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_task_intake').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});
test('only authenticated exact phone and approved group can invoke model',async t=>{
 const f=fixture(t);let calls=0;for(const extra of[{senderNumber:'12025550999'},{groupId:'999@g.us'}]){const r=await f.run(undefined,extra,async()=>{calls++;throw Error();});assert.equal(r.status,'denied');}assert.equal(calls,0);
});
test('history isolated by actor/group and never contains phone table',async t=>{
 const f=fixture(t);await f.run();let seen;
 await f.run(undefined,{senderNumber:'12025550102',groupId:'12345@g.us'},async input=>{seen=input;return emptySecretaryIntent('help');});assert.equal(seen.history.length,0);assert.doesNotMatch(JSON.stringify(seen),/1202555010/);assert.ok(seen.tasks.every(x=>x.id==='private'));
});
test('comment uses shared engine, no implicit completion, receipt duplicate does not repeat',async t=>{
 const f=fixture(t);const e=f.event({messageId:'COMMENT',text:'حكيت مع المحامي ولسه بستنى الرد'});const plan=command('comment',{body:e.text});const deps={infer:async()=>plan,now:()=>f.now};
 const first=await handleSecretaryEvent(f.db,e,f.config,deps);assert.equal(first.status,'applied');assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=\'t\'').get().status,'progress');
 const second=await handleSecretaryEvent(f.db,e,f.config,{...deps,infer:async()=>{throw Error('must not infer');}});assert.equal(second.status,'duplicate');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,1);
});
test('member completion waits for actor-bound confirmation; then only approval',async t=>{
 const f=fixture(t);const proposed=await f.run(command('submit'),{text:'خلصت اللوحة بالكامل'});assert.equal(proposed.status,'confirmation');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
 const token=pending(f.db).token;
 await f.run(emptySecretaryIntent('clarify','شو المقصود؟'),{senderNumber:'12025550102',text:`موافق ${token}`});assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
 const confirmed=await f.run(undefined,{text:`موافق ${token}`});assert.equal(confirmed.status,'applied');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'approval');assert.equal(f.db.prepare("SELECT completed_at FROM tasks WHERE id='t'").get().completed_at,null);
 const audit=JSON.parse(f.db.prepare("SELECT details FROM audit_logs WHERE action='submit'").get().details);assert.equal(audit.auditContext.confirmedBy,'member');assert.equal(audit.auditContext.originalText,'خلصت اللوحة بالكامل');
});
test('cancellation and expired confirmation never mutate',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة'});assert.equal((await f.run(undefined,{text:'إلغاء'})).status,'cancelled');assert.equal(pending(f.db),undefined);
 await f.run(command('submit'),{text:'خلصت اللوحة'});const token=pending(f.db).token;f.tick(600001);assert.equal((await f.run(undefined,{text:`موافق ${token}`})).status,'stale');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
});
test('task changes before confirmation invalidate exact proposal',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة'});const token=pending(f.db).token;f.db.exec("UPDATE tasks SET updated_at=2 WHERE id='t'");assert.equal((await f.run(undefined,{text:`موافق ${token}`})).status,'stale');
});
test('permissions changed while awaiting model prevent mutation',async t=>{
 const f=fixture(t);const r=await f.run(command('comment',{body:'update'}),{},async()=>{f.db.exec("UPDATE users SET active=0 WHERE id='member'");return command('comment',{body:'update'});});assert.equal(r.status,'denied');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});
test('forged model task ID and member admin action cannot write',async t=>{
 const f=fixture(t);assert.equal((await f.run(command('delete_task'),{text:'احذف المهمة'})).status,'denied');assert.equal(pending(f.db),undefined);
 assert.equal((await f.run(command('comment',{body:'hack'},'private'))).status,'clarify');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});
test('manager create task and project use real authorized IDs; delete needs confirmation',async t=>{
 const f=fixture(t);const e={senderNumber:'12025550103',text:'افتح مشروع تجريبي جديد'};
 assert.equal((await f.run(command('add_project',{name:'مشروع جديد'},null),e)).status,'applied');
 assert.equal((await f.run(command('add_task',{title:'مهمة جديدة',ownerId:'member',priority:'yellow',dueDate:'unscheduled'},null,'p'),{...e,text:'ضيف مهمة جديدة لخالد بأولوية متوسطة وبدون موعد'})).status,'confirmation');
 assert.equal((await f.run(undefined,{...e,text:`موافق ${pending(f.db).token}`})).status,'applied');
 assert.equal((await f.run(command('delete_task',{},'private'),{...e,text:'احذف مهمة شادي'})).status,'confirmation');assert.ok(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get());
});
test('reused message ID changed body fails closed and cannot expose remapped replies',async t=>{
 const f=fixture(t);const e=f.event();await handleSecretaryEvent(f.db,e,f.config,{infer:async()=>emptySecretaryIntent('summary')});
 assert.equal((await handleSecretaryEvent(f.db,{...e,text:'something else'},f.config,{infer:async()=>{throw Error();}})).status,'denied');
 f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='t'");assert.equal((await handleSecretaryEvent(f.db,e,f.config,{infer:async()=>{throw Error();}})).status,'denied');
});
test('quoted reply cannot borrow another actor context or older confirmation',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة',responseMessageId:'BOT-PROPOSAL'});
 const token=pending(f.db).token;const r=await f.run(undefined,{text:`موافق ${token}`,replyToMessageId:'NONEXISTENT'});assert.equal(r.status,'clarify');
 const good=await f.run(undefined,{text:'نعم',replyToMessageId:'BOT-PROPOSAL'});assert.equal(good.status,'applied');
});
test('receipt failure rolls back management write and audit',async t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON secretary_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
 await assert.rejects(f.run(command('comment',{body:'update'})));assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
});
test('model inputs contain only catalog titles/status/IDs, not task details or login data',async t=>{
 const f=fixture(t);await f.run(undefined,{},async input=>{assert.doesNotMatch(JSON.stringify(input),/تفاصيل تنفيذ|pin_hash|senderNumber|sharedKey/);return emptySecretaryIntent('help');});
});
test('partial and future completion are not submit',()=>{
 for(const text of['ما خلصت اللوحة','لسه ناقص شيء','بكرا بخلص','half done?']){const input={text,tasks:[{id:'t',title:'لوحة',projectId:'p',status:'progress'}],projects:[],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};assert.equal(validateSecretaryIntent(command('submit'),input).kind,'clarify');}
});
test('explicit reminder is durable, sent once and not sent for completed work',async t=>{
 const f=fixture(t);let p=emptySecretaryIntent('remind');p.taskId='t';p.fields.remindAt=new Date(f.now+120000).toISOString();assert.equal((await f.run(p,{text:'ذكرني باللوحة بعد دقيقتين'})).status,'scheduled');f.tick(120001);
 const worker=createSecretaryJobs({db:f.db,config:f.config,now:()=>f.now});let sent=0;assert.equal((await worker.deliverNext(async message=>{sent++;assert.equal(message.to,'12025550101@s.whatsapp.net');assert.match(message.text,/اللوحة|لوحة/);})).status,'sent');assert.equal((await worker.deliverNext(async()=>sent++)).status,'idle');assert.equal(sent,1);
 p.fields.remindAt=new Date(f.now+120000).toISOString();await f.run(p);f.tick(120001);f.db.exec("UPDATE tasks SET status='completed' WHERE id='t'");assert.equal((await worker.deliverNext(async()=>sent++)).status,'failed');assert.equal(sent,1);
});
test('provider search never receives catalog or history and requires actual web tool evidence',async()=>{
 let body;const reply=await searchSecretaryWeb('LG televisions Jordan',{apiKey:'synthetic',fetcher:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'نتيجة https://example.com/product',executed_tools:[]}}]});}});
 assert.equal(body.model,'openai/gpt-oss-120b');assert.deepEqual(body.tools,[{type:'browser_search'}]);assert.equal(body.tool_choice,'required');assert.doesNotMatch(JSON.stringify(body),/taskCatalog|senderNumber|contacts/);assert.match(reply,/ما قدرت أتحقق/);
});
test('planner response limits reject tool calls and success cannot come from model JSON',async()=>{
 const input={text:'مرحبا',tasks:[],projects:[],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};
 await assert.rejects(inferSecretaryIntent(input,{apiKey:'synthetic',fetcher:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emptySecretaryIntent('help')),tool_calls:[{}]}}]})}));
});

test('voice create/comment/reminder always require confirmation before any write',async t=>{
 const f=fixture(t);const result=await f.run(command('comment',{body:'تحديث صوتي'}),{text:'سجل تحديث صوتي',inputKind:'voice'});assert.equal(result.status,'confirmation');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
 assert.match(result.reply,/فهمت من الصوت/);await f.run(undefined,{text:'إلغاء'});
 const p=emptySecretaryIntent('remind');p.taskId='t';p.fields.remindAt=new Date(f.now+120000).toISOString();assert.equal((await f.run(p,{inputKind:'voice'})).status,'confirmation');assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_reminders').get().n,0);
 assert.equal((await f.run(undefined,{text:`موافق ${pending(f.db).token}`})).status,'scheduled');
});

test('identical titles require a uniquely named project, literal ID, or server-bound focus',()=>{
 const input={text:'سجل تحديث للوحة',tasks:[{id:'task-one',title:'لوحة',projectId:'p',status:'progress'},{id:'task-two',title:'لوحة',projectId:'p2',status:'progress'}],projects:[{id:'p',name:'المشروع الأول',status:'active'},{id:'p2',name:'المشروع الثاني',status:'active'}],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};
 const plan=command('comment',{body:'تحديث'},'task-one');
 assert.equal(validateSecretaryIntent(plan,input).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث للوحة في المشروع الأول'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,focusedTaskId:'task-one'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث task-one'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث في المشروع الأول',tasks:input.tasks.map(t=>({...t,projectId:'p'}))}).kind,'clarify');
});

test('freeform replies and history lose visibility when input task permissions change',async t=>{
 const f=fixture(t);const event=f.event();
 await handleSecretaryEvent(f.db,event,f.config,{infer:async()=>emptySecretaryIntent('chat','تذكرت حديثك عن اللوحة'),now:()=>f.now});
 f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='t'");
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:async()=>{throw Error('no repeated inference');},now:()=>f.now})).status,'denied');
 await f.run(undefined,{},async input=>{assert.equal(input.history.length,0);return emptySecretaryIntent('help');});
});

test('public search renders only source URLs actually returned by the search tool',async()=>{
 const reply=await searchSecretaryWeb('public product search',{apiKey:'synthetic',fetcher:async()=>Response.json({choices:[{message:{content:'Invented https://invented.example/',executed_tools:[{type:'web_search',search_results:{results:[{title:'Verified product',url:'https://example.com/product',content:'Source description'},{title:'Unsafe',url:'http://127.0.0.1/',content:'Discard'}]}}]}}]})});
 assert.match(reply,/https:\/\/example.com\/product/);assert.doesNotMatch(reply,/invented\.example|127\.0\.0\.1/);
});

test('late bare approval and old token/quote cannot execute a replacement request',async t=>{
 const f=fixture(t);const manager={senderNumber:'12025550103'};
 await f.run(command('edit_task',{title:'تعديل الطلب الأول'}),{...manager,text:'عدل عنوان اللوحة',responseMessageId:'PROPOSAL-A'});
 const firstToken=pending(f.db).token;
 await f.run(command('delete_task',{},'private'),{...manager,text:'احذف مهمة شادي',responseMessageId:'PROPOSAL-B'});
 const secondToken=pending(f.db).token;
 const noInference=async()=>{throw Error('confirmation attempts must never reach the model');};
 for(const extra of [{text:'نعم'},{text:`موافق ${firstToken}`},{text:'نعم',replyToMessageId:'PROPOSAL-A'},{text:`موافق ${secondToken}`,replyToMessageId:'PROPOSAL-A'}]) {
   const result=await f.run(undefined,{...manager,...extra},noInference);
   assert.equal(result.status,extra.text==='نعم'&&!extra.replyToMessageId?'confirmation':'clarify');assert.equal(pending(f.db).token,secondToken);
   assert.ok(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get());
   assert.equal(f.db.prepare("SELECT title FROM tasks WHERE id='t'").get().title,'لوحة');
 }
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_logs WHERE action IN ('delete','edit')").get().n,0);
 const event=f.event({...manager,text:`موافق ${secondToken}`});
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:noInference,now:()=>f.now})).status,'applied');
 assert.equal(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get(),undefined);
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:noInference,now:()=>f.now})).status,'duplicate');
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_logs WHERE action='delete'").get().n,1);
});

test('bare approval without a pending request cannot become a model-generated action',async t=>{
 const f=fixture(t);
 for(const text of ['نعم','موافق','تمام','موافق T123ABC']) {
   const result=await f.run(command('comment',{body:'must not be written'}),{text},async()=>{throw Error('do not infer approval');});
   assert.equal(result.status,text.includes('T123ABC')?'clarify':'summary');
   if(!text.includes('T123ABC')) { assert.match(result.reply,/أنا معك/);assert.doesNotMatch(result.reply,/ما في طلب|تم التنفيذ/); }
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});

test('duplicate project names require the selected literal ID in the current message',()=>{
 const input={text:'أضف مهمة إلى مشروع التجهيز',tasks:[{id:'task-one',title:'لوحة',projectId:'project-one',status:'progress'}],projects:[{id:'project-one',name:'مشروع التجهيز',status:'active'},{id:'project-two',name:'مَشروع التجهيز',status:'active'}],users:[],actor:{id:'basem',name:'باسم',role:'admin'},history:[{role:'user',content:'project-one'}],now:new Date().toISOString()};
 for(const plan of [command('add_task',{title:'تقرير جديد'},null,'project-one'),command('move_task',{},'task-one','project-one'),command('edit_project',{name:'اسم جديد'},null,'project-one'),command('delete_project',{},null,'project-one')]) {
   assert.equal(validateSecretaryIntent(plan,input).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:'نفذ في project-two'}).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:'نفذ في project-one-extra'}).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:plan.action==='add_task'?'أضف مهمة إلى project-one':'نفذ في project-one'}).kind,plan.action==='add_task'?'task_draft':'command');
 }
});

test('ambiguous project creation produces clarification and never inserts into a guessed project',async t=>{
 const f=fixture(t);f.db.exec("UPDATE projects SET name='مشروع تجريبي' WHERE id='p2'");
 const manager={senderNumber:'12025550103'};const plan=command('add_task',{title:'تقرير جديد',ownerId:'unassigned',priority:'yellow',dueDate:'unscheduled'},null,'p2');
 const before=f.db.prepare('SELECT count(*) n FROM tasks').get().n;
 assert.equal((await f.run(plan,{...manager,text:'أضف تقرير جديد إلى مشروع تجريبي'})).status,'clarify');
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,before);
 assert.equal(pending(f.db),undefined);
 assert.equal((await f.run(plan,{...manager,text:'أضف تقرير جديد إلى p2 بدون مسؤول وموعد بأولوية متوسطة'})).status,'confirmation');
 assert.equal((await f.run(undefined,{...manager,text:`موافق ${pending(f.db).token}`})).status,'applied');
 assert.equal(f.db.prepare("SELECT project_id FROM tasks WHERE title='تقرير جديد'").get().project_id,'p2');
});

test('history retains the latest eight exchanges within 24 hours in deterministic insertion order',async t=>{
 const f=fixture(t);
 await f.run(emptySecretaryIntent('chat','جواب قديم'),{text:'حديث منذ يوم'});
 f.tick(24*60*60_000);
 await f.run(emptySecretaryIntent('help'),{text:'اختبار الحد'},async input=>{assert.equal(input.history.length,0);return emptySecretaryIntent('help');});
 for(let i=0;i<10;i++) await f.run(emptySecretaryIntent('chat',`جواب ${i}`),{text:`حديث ${i}`});
 f.tick(60*60_000);
 await f.run(undefined,{},async input=>{
   assert.deepEqual(input.history.filter(item=>item.role==='user').map(item=>item.content),Array.from({length:8},(_,i)=>`حديث ${i+2}`));
   assert.deepEqual(input.history.filter(item=>item.role==='assistant').map(item=>item.content),Array.from({length:8},(_,i)=>`جواب ${i+2}`));
   return emptySecretaryIntent('help');
 });
});

test('history and quoted context share a 6000-character budget without changing role isolation',async t=>{
 const f=fixture(t);
 for(let i=0;i<8;i++) await f.run(emptySecretaryIntent('chat',`جواب ${i} ${'س'.repeat(1300)}`),{text:`حديث ${i} ${'ن'.repeat(1800)}`,responseMessageId:`LONG-${i}`});
 await f.run(undefined,{text:'وضح الكلام',replyToMessageId:'LONG-7'},async input=>{
   assert.ok(input.history.length<=17);
   assert.ok(input.history.reduce((sum,item)=>sum+item.content.length,0)<=6000);
   assert.ok(input.history.every(item=>['user','assistant'].includes(item.role)));
   assert.match(input.history[input.history.length-1].content,/الرسالة التي يرد عليها/);
   assert.ok(input.history.some(item=>item.content.startsWith('حديث 7')));
   return emptySecretaryIntent('help');
 });
});

test('contextual chat and friendly acknowledgment retain focus but a new topic clears it',async t=>{
 const f=fixture(t);const details={...emptySecretaryIntent('details'),taskId:'t'};
 await f.run(details,{text:'اشرح اللوحة'});
 const chat={...emptySecretaryIntent('chat','المقصود تجهيز اللوحة ومتابعة المورد.'),taskId:'t'};
 await f.run(chat,{text:'شو يعني؟'},async input=>{assert.equal(input.focusedTaskId,'t');return chat;});
 const ack=await f.run(undefined,{text:'تمام'},async()=>{throw Error('friendly acknowledgment must not invoke model');});
 assert.equal(ack.status,'summary');assert.equal(ack.taskId,'t');assert.match(ack.reply,/لوحة/);
 await f.run(undefined,{text:'شو أحسن طريقة أرتب يومي؟'},async input=>{assert.equal(input.focusedTaskId,'t');return emptySecretaryIntent('chat','ابدأ بتحديد أولويات يومك.');});
 await f.run(undefined,{text:'اشرح أكثر'},async input=>{assert.equal(input.focusedTaskId,null);return emptySecretaryIntent('chat','قسّم وقتك إلى فترات قصيرة.');});
 assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
 assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
});

test('inaccessible history cannot supply focus even when its result points to a still-visible task',async t=>{
 const f=fixture(t);
 f.db.exec("UPDATE tasks SET owner='خالد',suggested_owner='خالد' WHERE id='private'");
 await f.run({...emptySecretaryIntent('chat','كلام سياقي عن المهمة'),taskId:'t'});
 f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='private'");
 await f.run(undefined,{},async input=>{assert.equal(input.history.length,0);assert.equal(input.focusedTaskId,null);return emptySecretaryIntent('help');});
});

test('clarifying questions preserve the exact pending proposal and plain approval first restates it',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة بالكامل',responseMessageId:'PENDING-SUBMIT'});
 const before={...pending(f.db)};
 await f.run({...emptySecretaryIntent('chat','المهمة تذهب إلى باسم للمراجعة ولا تصبح معتمدة تلقائيًا.'),taskId:'t'},{text:'شو يعني بانتظار الاعتماد؟'});
 assert.deepEqual({...pending(f.db)},before);
 await f.run({...emptySecretaryIntent('clarify','بدك أوضح خطوة المراجعة؟'),taskId:'t'},{text:'وضح أكثر'});
 assert.deepEqual({...pending(f.db)},before);
 assert.equal((await f.run(undefined,{text:'نعم'})).status,'confirmation');
 assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
 assert.equal(pending(f.db).token,before.token);
 assert.equal((await f.run(undefined,{text:`موافق ${before.token}`})).status,'applied');
 assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'approval');
});

test('conversational replies preserve negation and drafts but suppress clear invented execution',async t=>{
 const f=fixture(t);
 for(const reply of ['ما غيّرت المهمة.','هل أضفت المهمة؟','صياغة مقترحة: «أضفت المهمة».']) {
   assert.equal((await f.run(emptySecretaryIntent('chat',reply),{text:'وضحلي'})).reply,reply);
 }
 assert.match((await f.run(emptySecretaryIntent('chat','أضفت المهمة الجديدة للمشروع.'),{text:'مرحبا'})).reply,/ما نفّذت أي تغيير/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
 assert.equal((await f.run(command('delete_task'),{senderNumber:'12025550103',text:'كيف أحذف اللوحة؟'})).status,'clarify');
 assert.equal(pending(f.db),undefined);
});

test('owner private team message previews exact recipients and text then queues only after exact confirmation',async t=>{
 const f=fixture(t);const manager={senderNumber:'12025550103',text:'ابعث للتيم على الخاص: الاجتماع بكرا الساعة 10',responseMessageId:'TEAM-PREVIEW'};
 const first=await f.run(teamMessage(),manager,async input=>{
   assert.equal(input.canMessageTeam,true);
   assert.deepEqual(input.messageRecipients.map(x=>x.id).sort(),['member','other']);
   assert.doesNotMatch(JSON.stringify(input),/1202555010/);
   return teamMessage();
 });
 assert.equal(first.status,'confirmation');assert.match(first.reply,/خالد/);assert.match(first.reply,/شادي/);assert.match(first.reply,/الاجتماع بكرا الساعة 10/);assert.match(first.reply,/لم أرسل شيئًا/);
 const jobs=createSecretaryOutboxJobs({db:f.db,config:f.config,now:()=>f.now});let sent=[];
 assert.equal((await jobs.deliverNext(async m=>{sent.push(m);})).status,'idle');
 const queued=await f.run(undefined,{...manager,text:'نعم'});
 assert.equal(queued.status,'queued');assert.match(queued.reply,/ليس تأكيد وصول/);
 for(let i=0;i<5;i++) await jobs.deliverNext(async m=>{sent.push(m);});
 const staff=sent.filter(m=>m.to!=='12025550103@s.whatsapp.net');
 assert.deepEqual(staff.map(m=>m.to).sort(),['12025550101@s.whatsapp.net','12025550102@s.whatsapp.net']);
 assert.ok(staff.every(m=>m.text==='الاجتماع بكرا الساعة 10'));assert.ok(sent.every(m=>!m.to.endsWith('@g.us')));
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
 const status=await f.run(emptySecretaryIntent('message_status'),{...manager,text:'شو صار بالإرسال؟'});
 assert.match(status.reply,/خالد|شادي/);assert.match(status.reply,/النقل وحده لا يثبت الوصول أو القراءة/);assert.match(status.reply,/إقرار خادم واتساب: 0/);assert.doesNotMatch(status.reply,/1202555010/);
});

test('team sends are denied to members and group-origin requests',async t=>{
 const f=fixture(t);
 for(const extra of [{text:'ابعث للتيم مرحبا'},{text:'ابعث للتيم مرحبا',senderNumber:'12025550103',groupId:'12345@g.us'}]) {
   assert.equal((await f.run(teamMessage(),extra)).status,'clarify');assert.equal(pending(f.db),undefined);
 }
 const jobs=createSecretaryOutboxJobs({db:f.db,config:f.config,now:()=>f.now});
 assert.equal((await jobs.deliverNext(async()=>{throw Error('must not send');})).status,'idle');
});

test('correction replaces preview with exact full draft context; old token and cancellation cannot send',async t=>{
 const f=fixture(t);const manager={senderNumber:'12025550103'};
 const long='تفاصيل تجريبية '.repeat(90);
 await f.run(teamMessage(long,['member']),{...manager,text:'ابعث لخالد التفاصيل'});const old=pending(f.db).token;
 await f.run(teamMessage('الاجتماع الساعة 11',['member']),{...manager,text:'لا خليها الساعة 11'},async input=>{
   assert.equal(input.pendingMessagePreview.text,long.trim());assert.deepEqual(input.pendingMessagePreview.recipientIds,['member']);return teamMessage('الاجتماع الساعة 11',['member']);
 });
 assert.notEqual(pending(f.db).token,old);
 assert.equal((await f.run(undefined,{...manager,text:`موافق ${old}`})).status,'clarify');
 assert.equal((await f.run(undefined,{...manager,text:'إلغاء'})).status,'cancelled');
 const jobs=createSecretaryOutboxJobs({db:f.db,config:f.config,now:()=>f.now});
 assert.equal((await jobs.deliverNext(async()=>{throw Error('must not send');})).status,'idle');
});

test('duplicate message confirmation never enqueues twice; mapping changed after preview fails closed',async t=>{
 const f=fixture(t);const manager={senderNumber:'12025550103'};
 await f.run(teamMessage('اختبار',['member']),{...manager,text:'ابعث لخالد اختبار'});const token=pending(f.db).token;
 f.config.contacts.find(x=>x.userId==='member').number='12025550999';
 assert.equal((await f.run(undefined,{...manager,text:`موافق ${token}`})).status,'clarify');
 const jobs=createSecretaryOutboxJobs({db:f.db,config:f.config,now:()=>f.now});assert.equal((await jobs.deliverNext(async()=>{throw Error('must not send');})).status,'idle');
 f.config.contacts.find(x=>x.userId==='member').number='12025550101';
 await f.run(teamMessage('اختبار جديد',['member']),{...manager,text:'ابعث لخالد اختبار جديد'});
 const e=f.event({...manager,text:`موافق ${pending(f.db).token}`});const deps={infer:async()=>{throw Error('confirmation does not need model');},now:()=>f.now};
 assert.equal((await handleSecretaryEvent(f.db,e,f.config,deps)).status,'queued');
 assert.equal((await handleSecretaryEvent(f.db,e,f.config,deps)).status,'duplicate');
 const s=getSecretaryOutboxStatus(f.db,{actor:{id:'basem',name:'باسم',role:'admin',active:1},origin:{senderNumber:manager.senderNumber,groupId:null}},f.config);
 assert.equal(s.recipientCount,1);
});



test('general task question recovers from inference failure with scoped live data only',async t=>{
 const f=fixture(t);const fail=async()=>{throw Error('provider unavailable');};
 for(const text of ['شو المهام المطلوبه','شو المهام المطلوبة؟','شو مهامي؟']){
   const r=await f.run(null,{text},fail);assert.equal(r.status,'summary');
   assert.match(r.reply,/🔵 \*مشروع تجريبي\*/);assert.match(r.reply,/🔴 لوحة/);
   assert.doesNotMatch(r.reply,/مهمة شادي|تفاصيل سرية|https?:/);
 }
 for(const text of ['احذف المهام','شو المهام المطلوبة في مشروع ثان','شو المهام المطلوبة بكرا']){
   await assert.rejects(f.run(null,{text},fail),/provider unavailable/);
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});

test('conversational lists enforce bold project headings with ordinary task names', async()=>{
 const {formatSecretaryProjectHeadings}=await import('../lib/secretary-service.ts');
 const state={projects:[{name:'مشروع تجريبي'}],tasks:[{title:'مهمة أولى'}]};
 assert.equal(formatSecretaryProjectHeadings('🔵 مشروع تجريبي\n🔴 **مهمة أولى**',state),'🔵 *مشروع تجريبي*\n🔴 مهمة أولى');
 assert.equal(formatSecretaryProjectHeadings('🔵 **مشروع تجريبي**:\n🟢 مهمة أولى',state),'🔵 *مشروع تجريبي*:\n🟢 مهمة أولى');
 assert.equal(formatSecretaryProjectHeadings('ناقشنا مشروع تجريبي اليوم',state),'ناقشنا مشروع تجريبي اليوم');
});

test('project test request survives model start metadata and confirms once without team notices',async t=>{
 const f=fixture(t);
 const plan=emptySecretaryIntent('project_draft');plan.intakeMode='start';plan.fields.name='تجربة السكرتير';plan.message='اختبار فقط | - | green | -';
 const preview=await f.run(plan,{senderNumber:'12025550103',text:'افتح مشروع اسمه تجربة السكرتير، فيه مهمة اختبار فقط، ولا تبعت أي رسالة للفريق'});
 assert.equal(preview.status,'confirmation');assert.match(preview.reply,/بدون إرسال إشعارات/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n,2);
 const token=pending(f.db).token;
 const event=f.event({senderNumber:'12025550103',text:'موافق '+token});
 const run=()=>handleSecretaryEvent(f.db,event,f.config,{now:()=>f.now,infer:async()=>assert.fail('confirmation must not infer')});
 const result=await run();assert.equal(result.status,'applied');await run();
 assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n,3);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,3);
 assert.equal(f.db.prepare('SELECT count(*) n FROM agent_outbox').get().n,0);
});


test('ordinary task listing bypasses unavailable provider without dropping filters',async t=>{
 const f=fixture(t);
 const r=await f.run(null,{text:'وريني المهام كلها كمان مره'},async()=>assert.fail('list does not need inference'));
 assert.equal(r.status,'summary');assert.match(r.reply,/لوحة/);assert.doesNotMatch(r.reply,/مهمة شادي/);
 let called=false;await f.run(null,{text:'وريني المهام كلها بكرا'},async()=>{called=true;return emptySecretaryIntent('clarify','أي موعد؟')});
 assert.equal(called,true);
});

test('general summary groups all 25 short tasks under one bold heading without trailing spaces',async t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM tasks WHERE id='private'").run();
 for(let i=2;i<=25;i++)f.db.prepare("INSERT INTO tasks(id,project_id,title,details,priority,status,owner,suggested_owner,created_at,updated_at) VALUES(?, 'p', ?, '', 'green', 'open', NULL, 'خالد', 1, 1)").run('grouped-'+i,'مهمة تجريبية '+i);
 const r=await f.run(null,{text:'وريني المهام كلها كمان مره'},async()=>assert.fail());
 assert.equal((r.reply.match(/🔵 \*مشروع تجريبي\*/g)||[]).length,1);
 assert.match(r.reply,/مهمة تجريبية 25/);assert.match(r.reply,/جميع المهام \(25\)/);
 assert.doesNotMatch(r.reply,/&#x20;| +\n|\*مهمة/);assert.ok(r.reply.length<4000);
});

