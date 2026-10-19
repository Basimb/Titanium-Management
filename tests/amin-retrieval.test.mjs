import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {searchAminConversation} from '../lib/amin-retrieval.ts';
import {inferSecretaryIntent,emptySecretaryIntent} from '../lib/secretary-intent.ts';
import {inspectAminContext} from '../lib/secretary-deliberation.ts';
import {handleSecretaryEvent,migrateSecretary} from '../lib/secretary-service.ts';
import {migrateAgentSchema} from '../lib/agent-schema.ts';

const now=1792040400000;
test('conversation retrieval filters actor, conversation, revoked task, membership epoch and future before ranking',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE secretary_events(event_key TEXT, actor_id TEXT, conversation_key TEXT, original_text TEXT, result_json TEXT, scope_json TEXT, created_at INTEGER)');
 const put=(id,actor,conv,scope,at)=>db.prepare('INSERT INTO secretary_events VALUES(?,?,?,?,?,?,?)').run(id,actor,conv,'مرجع المورد',JSON.stringify({reply:id}),scope,at);
 put('own','staff','private','[]',now-100);
 put('other-actor','other','private','[]',now-100);
 put('other-chat','staff','other','[]',now-100);
 put('revoked-task','staff','private','["t:revoked"]',now-100);
 put('before-role-change','staff','private','[]',now-5000);
 put('future','staff','private','[]',now+1);
 put('malformed','staff','private','{}',now-100);
 put('allowed-task','staff','private','["t:own"]',now-100);
 const input={actorId:'staff',conversation:'private',query:'المورد',scope:new Set(['t:own']),now,since:now-1000};
 const hits=searchAminConversation(db,input);
 assert.deepEqual(hits.map(x=>x.sourceId).sort(),['allowed-task','own']);
 assert.ok(hits.every(x=>x.evidence.includes('not current facts')));
 assert.equal(searchAminConversation(db,{...input,query:"%' OR 1=1 --"}).length,0);
});

test('retrieval reaches an older relevant exchange behind eight newer messages and bounds output',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE secretary_events(event_key TEXT, actor_id TEXT, conversation_key TEXT, original_text TEXT, result_json TEXT, scope_json TEXT, created_at INTEGER)');
 for(let i=0;i<20;i++)db.prepare('INSERT INTO secretary_events VALUES(?,?,?,?,?,?,?)').run('e'+i,'staff','p',i===0?'مرجع المورد S-42':'مرحبا',JSON.stringify({reply:'معلومات تجريبية '+ 'x'.repeat(10000)}),'[]',now-1000+i);
 const hits=searchAminConversation(db,{actorId:'staff',conversation:'p',query:'المورد',scope:new Set(),now,since:0});
 assert.equal(hits.length,1);assert.equal(hits[0].sourceId,'e0');assert.equal(hits[0].aminReplied.length,500);
});

const input={text:'راجع المرجع الداخلي وأجب',actor:{id:'staff',name:'تجريبي',role:'member'},tasks:[],users:[],history:[],now:new Date(now).toISOString()};
const response=(name,args,id='r')=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
test('actual planner consumes focused retrieval, inspects again and returns a final answer without serializing the capability',async()=>{
 const reads=[];let turns=0;
 const plan=await inferSecretaryIntent({...input,retrieveInternal:q=>{reads.push(q);return {items:[{title:'إجراء المورد',body:'راجع المرجع S-42'}]};}},{apiKey:'synthetic',fetcher:async(_url,opts)=>{
  const body=JSON.parse(opts.body);assert.ok(!body.messages[1].content.includes('retrieveInternal'));
  turns++;
  if(turns===1){assert.ok(body.tools.some(x=>x.function.name==='search_internal'));return response('search_internal',{source:'knowledge',query:'المورد'});}
  if(turns===2){assert.match(body.messages.at(-1).content,/S-42/);return response('inspect_context',{topic:'capabilities'},'r2');}
  return response('chat',{message:'حسب الإجراء الداخلي راجع المرجع S-42.',taskId:null},'r3');
 }});
 assert.equal(plan.kind,'chat');assert.match(plan.message,/S-42/);assert.equal(reads.length,1);assert.equal(turns,3);
});
test('unavailable retrieval, identity injection and invalid arguments never reach a server reader',()=>{
 assert.throws(()=>inspectAminContext('search_internal','{"source":"knowledge","query":"المورد"}',input));
 let calls=0;const context={...input,retrieveInternal:()=>{calls++;return {};}};
 for(const args of [{source:'knowledge',query:'المورد',actor:'basem'},{source:'files',query:'/etc/passwd'},{source:'knowledge',query:' '},{source:'conversation',query:'x'.repeat(201)}])assert.throws(()=>inspectAminContext('search_internal',JSON.stringify(args),context));
 assert.equal(calls,0);
});

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
 CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
 CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
 CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
 INSERT INTO users VALUES('basem','مدير تجريبي','admin',1,NULL,1,1),('staff-test','موظف تجريبي','member',1,NULL,1,1);`);
 migrateSecretary(db);migrateAgentSchema(db);
 const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'staff-test',number:'12025550101'}],allowedGroupIds:['test@g.us']};
 const say=(text,id,infer,extra={})=>handleSecretaryEvent(db,{messageId:id,senderNumber:'12025550101',groupId:null,text,receivedAt:now,...extra},config,{infer,now:()=>now});
 return {db,config,say};
}
test('real service exposes private retrieval and returns permitted knowledge with source; private owner record stays excluded',async t=>{
 const f=fixture(t);
 for(const [id,visibility,body] of [['team','team','رقم مرجع المورد S-42'],['secret','owner','سر المالك OWNER-ONLY']])f.db.prepare('INSERT INTO knowledge(id,title,body,category,visibility,added_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'إجراء المورد',body,'general',visibility,'basem',now,now);
 const result=await f.say('احكيلي عن إجراء المورد التجريبي','knowledge',async context=>{
  const r=context.retrieveInternal({source:'knowledge',query:'المورد'});
  assert.equal(r.count,1);assert.equal(r.items[0].sourceId,'team');assert.match(r.items[0].body,/S-42/);assert.ok(!JSON.stringify(r).includes('OWNER-ONLY'));
  return emptySecretaryIntent('chat','حسب المرجع الداخلي: S-42.');
 });
 assert.match(result.reply,/S-42/);assert.equal(f.db.prepare('SELECT count(*) n FROM agent_outbox').get().n,0);
});
test('real service revalidates identity during retrieval and rejects deactivation before final answer',async t=>{
 const f=fixture(t);
 const r=await f.say('راجع معلومات المورد التجريبي','inactive',async context=>{
  f.db.prepare("UPDATE users SET active=0 WHERE id='staff-test'").run();
  assert.throws(()=>context.retrieveInternal({source:'knowledge',query:'المورد'}),/reference_actor_changed/);
  return emptySecretaryIntent('chat','جواب لا يجب إرساله');
 });
 assert.equal(r.status,'denied');assert.equal(r.reply,'');
});
test('retrieval memory carries an older private exchange through the actual service and does not enqueue actions',async t=>{
 const f=fixture(t);
 await f.say('مرجع المورد التجريبي S-42','old',async()=>emptySecretaryIntent('chat','سأستخدم هذا كمرجع للحوار.'));
 for(let i=0;i<10;i++)await f.say('هلا يا أمين','new'+i,async()=>emptySecretaryIntent('chat','هلا'));
 await f.say('شو كان مرجع المورد التجريبي','recall',async context=>{
  const r=context.retrieveInternal({source:'conversation',query:'المورد'});
  assert.ok(r.items.some(x=>x.staffSaid.includes('S-42')));
  assert.ok(r.items.every(x=>x.evidence.includes('not current facts')));
  return emptySecretaryIntent('chat','المرجع الذي ذكرته سابقًا S-42.');
 });
 assert.equal(f.db.prepare('SELECT count(*) n FROM agent_outbox').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
