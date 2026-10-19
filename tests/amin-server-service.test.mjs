import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {handleSecretaryEvent,migrateSecretary} from '../lib/secretary-service.ts';import {emptySecretaryIntent} from '../lib/secretary-intent.ts';import {createAminServerWorker} from '../lib/amin-server-work.ts';import {migrateAgentSchema} from '../lib/agent-schema.ts';
const at=1792044000000;
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
 const plan={...emptySecretaryIntent('server_work'),fields:{...emptySecretaryIntent().fields,body:'do not trust this replacement'}};
 const say=(text,id,extra={},deps={})=>handleSecretaryEvent(db,{messageId:id,senderNumber:'12025550103',groupId:null,text,receivedAt:at,...extra},config,{infer:async()=>plan,now:()=>at,serverWorkEnabled:true,...deps});
 return {db,config,say};
}
test('actual WhatsApp service queues exact owner request once and consumes its vote through the same private conversation',async t=>{
 const f=fixture(t),text='افحص الملف الاصطناعي على السيرفر وعدّل عنوانه';const r=await f.say(text,'request');assert.equal(r.status,'queued');assert.equal(f.db.prepare('SELECT request FROM amin_server_jobs').get().request,text);
 assert.equal((await f.say(text,'request')).status,'duplicate');assert.equal(f.db.prepare('SELECT count(*) n FROM amin_server_jobs').get().n,1);
 const worker=createAminServerWorker({db:f.db,enabled:()=>true,now:()=>at,plan:async()=>({name:'write_file',args:{path:'qa_data/synthetic.txt',content:'x',expect_md5:'missing'},summary:'أنشئ ملف اختبار اصطناعي فقط'}),rpc:async()=>({ok:true,result:{tools:[]}})});t.after(()=>worker.stop());await worker.tick();
 const a=f.db.prepare('SELECT * FROM amin_server_actions').get(),choice={questionId:a.poll_id,optionId:a.yes_id};
 const denied=await f.say('أوافق','wrong-actor',{senderNumber:'12025550101',choice});assert.equal(denied.status,'denied');assert.equal(f.db.prepare('SELECT state FROM amin_server_actions').get().state,'proposed');
 const vote=await f.say('أوافق','vote',{choice});assert.equal(vote.status,'queued');assert.equal(f.db.prepare('SELECT state FROM amin_server_actions').get().state,'approved');assert.equal((await f.say('أوافق','vote',{choice})).status,'duplicate');
});
test('staff, group and absent worker cannot enqueue server execution even when a provider invents that action',async t=>{
 for(const [extra,deps]of [[{senderNumber:'12025550101'},{}],[{groupId:'test@g.us'},{}],[{},{serverWorkEnabled:false}]]){
  const f=fixture(t);await f.say('سكرتير افحص الملف على السيرفر','denied',extra,deps);assert.equal(f.db.prepare('SELECT count(*) n FROM amin_server_jobs').get().n,0);
 }
});
