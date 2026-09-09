import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleTeamChatRequest, signTeamChatBody } from '../lib/team-chat-gateway.ts';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function setup(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','مدير تجريبي','admin',1,NULL,1,1),('member','موظف تجريبي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','مدير تجريبي',1,NULL,NULL,NULL);`);
  migrateSecretary(db);
  const clock=1788606000000,key='cd'.repeat(32),number='12025550901';
  const config={enabled:true,sharedKey:key,contacts:[{userId:'basem',number}],allowedGroupIds:[]};
  let seq=0,calls=0;
  const send=async(extra={},infer)=>{
    const raw=JSON.stringify({messageId:`VOTE-${++seq}`,responseMessageId:`REPLY-${seq}`,senderNumber:number,groupId:null,text:'أضف مهمة تقرير تجريبي ضمن مشروع تجريبي بدون مسؤول حاليًا',receivedAt:clock,...extra});
    const timestamp=String(clock);
    const request=new Request('https://example.test/api/whatsapp/team-chat',{method:'POST',body:raw,headers:{'content-type':'application/json','x-titanium-chat-timestamp':timestamp,'x-titanium-chat-signature':signTeamChatBody(raw,timestamp,key)}});
    const response=await handleTeamChatRequest(request,{config,getDatabase:()=>db,now:()=>clock,
      secretary:(database,event,policy)=>handleSecretaryEvent(database,event,policy,{now:()=>clock,infer:async input=>{calls++;if(!infer)throw Error('selection must not reach language provider');return infer(input);}})});
    assert.equal(response.status,200);return response.json();
  };
  return {db,send,calls:()=>calls};
}

test('signed choice traverses gateway into deterministic intake, never creates before preview confirmation',async t=>{
  const f=setup(t);const empty=emptySecretaryIntent('task_draft');
  const start=await f.send({},()=>({...empty,intakeMode:'start',projectId:'p',fields:{...empty.fields,title:'تقرير تجريبي',ownerId:'unassigned'}}));
  assert.ok(start.choices);const green=start.choices.options.find(o=>/عادية/.test(o.label));assert.ok(green);
  const dateQuestion=await f.send({text:green.label,choice:{questionId:start.choices.id,optionId:green.id}});
  assert.ok(dateQuestion.choices);const noDate=dateQuestion.choices.options.find(o=>/بدون موعد/.test(o.label));assert.ok(noDate);
  const preview=await f.send({text:noDate.label,choice:{questionId:dateQuestion.choices.id,optionId:noDate.id}});
  assert.equal(preview.status,'confirmation');
  // The final yes/no step is itself a tappable poll now, end to end through the signed gateway.
  assert.ok(preview.choices);const yes=preview.choices.options.find(o=>/موافق/.test(o.label));assert.ok(yes);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
  const accepted=await f.send({choice:{questionId:preview.choices.id,optionId:yes.id}});assert.equal(accepted.status,'applied');
  const task=f.db.prepare('SELECT priority,status,due_date,suggested_owner FROM tasks').get();
  assert.deepEqual({...task},{priority:'green',status:'open',due_date:null,suggested_owner:null});
  assert.equal(f.calls(),1,'clicks and final token do not require a model call');
});
