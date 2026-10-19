import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {handleSecretaryEvent,migrateSecretary} from '../lib/secretary-service.ts';
import {emptySecretaryIntent} from '../lib/secretary-intent.ts';import {migrateAgentSchema} from '../lib/agent-schema.ts';
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
 const plan={...emptySecretaryIntent('owner_message'),fields:{...emptySecretaryIntent().fields,body:'لا تستعمل ملخصًا مختلقًا'}};
 let seen;
 const say=(text,id='event1',opts={},deps={})=>handleSecretaryEvent(db,{messageId:id,senderNumber:'12025550101',groupId:null,text,receivedAt:1792040400000,responseMessageId:'reply-'+id,...opts},config,{infer:async input=>{seen=input;return plan;},now:()=>1792040400000,ownerDeliveryEnabled:true,...deps});
 return {db,config,say,get seen(){return seen;}};
}
test('staff handoff is persisted once for Basim, exact original text, no fabricated delivery or task change',async t=>{
 const f=fixture(t);const text='بلّغ الدكتور يشوف الملف لما يفضى';
 const result=await f.say(text);assert.equal(result.status,'queued');assert.match(result.reply,/طابور/);assert.match(result.reply,/لسه/);
 const rows=f.db.prepare('SELECT * FROM agent_outbox').all();assert.equal(rows.length,1);assert.equal(rows[0].to_user,'basem');assert.equal(rows[0].state,'pending');assert.ok(rows[0].text.includes(text));assert.ok(!rows[0].text.includes('ملخصًا مختلقًا'));
 assert.equal(f.seen.actor.id,'staff-test');assert.ok(f.seen.trainingLessons.some(x=>x.id==='owner-handoff'));
 const replay=await f.say(text);assert.equal(replay.status,'duplicate');assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
});
test('owner route cannot be invented when Basim has no configured contact',async t=>{
 const f=fixture(t);f.config.contacts=f.config.contacts.filter(c=>c.userId!=='basem');
 const r=await f.say('بلغ الدكتور عن الملف');assert.notEqual(r.status,'queued');assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n,0);
});
test('a group message or negated owner request cannot trigger the private staff handoff',async t=>{
 const f=fixture(t);await f.say('لا تبلغ الدكتور عن الملف');assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n,0);
 await f.say('سكرتير بلغ الدكتور عن الملف','event2',{groupId:'test@g.us'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n,0);
});
test('disabled delivery cannot accumulate owner handoffs under a false promise',async t=>{
 const f=fixture(t);const r=await f.say('بلغ الدكتور عن الملف','event1',{}, {ownerDeliveryEnabled:false});assert.notEqual(r.status,'queued');assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n,0);
});
