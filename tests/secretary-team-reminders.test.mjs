import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

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
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('t1','p','مهمة خالد الأولى','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);
    INSERT INTO tasks VALUES('t2','p','مهمة شادي','تفاصيل','yellow','open',NULL,'شادي',1,NULL,NULL,NULL,1,1,NULL,NULL);
    INSERT INTO tasks VALUES('t3','p','مهمة مكتملة','تفاصيل','green','completed','خالد','خالد',1,NULL,1,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  let sequence=0,now=Date.parse('2026-09-08T13:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us']};
  const event=(text,extra={})=>({messageId:`REM-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text,receivedAt:now,...extra});
  const run=(e,infer=async()=>{throw Error('this flow must never invoke the model');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const outbox=()=>db.prepare("SELECT to_user AS toUser,text FROM agent_outbox ORDER BY rowid").all();
  return {db,event,run,outbox,get now(){return now;}};
}

test('admin can trigger an on-demand team reminder from a private chat; a single approval sends it',async t=>{
  const f=fixture(t);
  const preview=await f.run(f.event('ابعت تذكير المهام الآن'));
  assert.equal(preview.status,'confirmation');
  assert.match(preview.reply,/خالد/);assert.match(preview.reply,/شادي/);
  assert.equal(f.outbox().length,0);
  const applied=await f.run(f.event('موافق'));
  assert.equal(applied.status,'applied');
  const sent=f.outbox();
  const toKhaled=sent.find(m=>m.toUser==='member'), toShadi=sent.find(m=>m.toUser==='other');
  const groupMessages=sent.filter(m=>m.toUser==='group');
  assert.ok(toKhaled);assert.match(toKhaled.text,/مهمة خالد الأولى/);assert.doesNotMatch(toKhaled.text,/مهمة مكتملة/);
  assert.ok(toShadi);assert.match(toShadi.text,/مهمة شادي/);
  // The group notice is one separate message per owner (Basim asked not to
  // combine everyone into a single group post), each headed by their own
  // bold red-circle name.
  assert.equal(groupMessages.length,2);
  const groupForKhaled=groupMessages.find(m=>/🔴 \*خالد\*/.test(m.text));
  const groupForShadi=groupMessages.find(m=>/🔴 \*شادي\*/.test(m.text));
  assert.ok(groupForKhaled);assert.match(groupForKhaled.text,/مهمة خالد الأولى/);assert.doesNotMatch(groupForKhaled.text,/شادي/);
  assert.ok(groupForShadi);assert.match(groupForShadi.text,/مهمة شادي/);assert.doesNotMatch(groupForShadi.text,/خالد/);
  assert.doesNotMatch(groupForKhaled.text+groupForShadi.text,/مهمة مكتملة/);
  assert.equal(sent.length,4);
});

test('the trigger phrase is admin-only and private-chat-only',async t=>{
  const f=fixture(t);
  // When the direct-intercept guard (admin + private chat) fails, the message
  // legitimately falls through to the normal AI-driven dispatch chain, which
  // needs to call infer() like any other unmatched message -- only assert
  // that the on-demand broadcast itself never got triggered.
  const chat=async()=>emptySecretaryIntent('chat','تمام.');
  const fromGroup=await f.run(f.event('ابعت تذكير المهام الآن',{groupId:'12345@g.us'}),chat);
  assert.notEqual(fromGroup.status,'confirmation');
  const fromMember=await f.run(f.event('ابعت تذكير المهام الآن',{senderNumber:'12025550101'}),chat);
  assert.notEqual(fromMember.status,'confirmation');
  assert.equal(f.outbox().length,0);
});

test('nothing to remind produces a clarify and sends nothing',async t=>{
  const f=fixture(t);
  f.db.exec("UPDATE tasks SET status='completed' WHERE id IN('t1','t2')");
  const result=await f.run(f.event('ابعت تذكير المهام الآن'));
  assert.equal(result.status,'clarify');
  assert.equal(f.outbox().length,0);
});
