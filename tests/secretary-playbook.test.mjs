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
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL);`);
  migrateSecretary(db);
  let sequence=0,now=Date.parse('2026-09-08T13:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'}],allowedGroupIds:['12345@g.us']};
  const event=(text,extra={})=>({messageId:`PB-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text,receivedAt:now,...extra});
  const run=(e,infer=async()=>{throw Error('this flow must never invoke the model');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const playbook=()=>db.prepare("SELECT body,updated_by FROM secretary_playbook WHERE id='main'").get();
  return {db,event,run,playbook,get now(){return now;}};
}

test('anyone asking the exact phrase gets the standing instructions, seeded by default',async t=>{
  const f=fixture(t);
  const admin=await f.run(f.event('تعليمات السكرتير'));
  assert.equal(admin.status,'summary');
  assert.match(admin.reply,/تعليمات مهمة لكل الفريق/);
  assert.match(admin.reply,/تذكير تلقائي بمهامكم مرتين كل يوم/);
  const member=await f.run(f.event('تعليمات السكرتير',{senderNumber:'12025550101'}));
  assert.equal(member.status,'summary');
  assert.equal(member.reply,admin.reply);
});

test('the exact-phrase trigger never fires on a message that merely mentions the topic',async t=>{
  const f=fixture(t);
  const chat=async()=>emptySecretaryIntent('chat','تمام.');
  const result=await f.run(f.event('بدي تعليمات السكرتير لو سمحت'),chat);
  // The direct-intercept must not have fired: a message merely mentioning
  // the topic still falls through to the normal AI-driven dispatch (whose
  // stubbed reply is distinct from the stored playbook text), not the
  // stored instructions verbatim.
  assert.doesNotMatch(result.reply,/تعليمات مهمة لكل الفريق/);
  assert.equal(result.reply,'تمام.');
});

test('admin can update the standing instructions from a private chat; a single approval saves it',async t=>{
  const f=fixture(t);
  const preview=await f.run(f.event('حدّث تعليمات السكرتير: نص تجريبي جديد للتعليمات.'));
  assert.equal(preview.status,'confirmation');
  assert.match(preview.reply,/نص تجريبي جديد للتعليمات/);
  assert.equal(f.playbook().body.includes('نص تجريبي جديد'),false);
  const applied=await f.run(f.event('موافق'));
  assert.equal(applied.status,'applied');
  assert.equal(f.playbook().body,'نص تجريبي جديد للتعليمات.');
  assert.equal(f.playbook().updated_by,'basem');
  const after=await f.run(f.event('تعليمات السكرتير'));
  assert.equal(after.reply,'نص تجريبي جديد للتعليمات.');
});

test('update is admin-only, private-chat-only, and never fires without a colon-separated body',async t=>{
  const f=fixture(t);
  const chat=async()=>emptySecretaryIntent('chat','تمام.');
  const memberAttempt=await f.run(f.event('حدّث تعليمات السكرتير: محاولة موظف',{senderNumber:'12025550101'}),chat);
  assert.notEqual(memberAttempt.status,'confirmation');
  const fromGroup=await f.run(f.event('حدّث تعليمات السكرتير: محاولة من الجروب',{groupId:'12345@g.us'}),chat);
  assert.notEqual(fromGroup.status,'confirmation');
  const noColon=await f.run(f.event('حدّث تعليمات السكرتير من فضلك'),chat);
  assert.notEqual(noColon.status,'confirmation');
  assert.equal(f.playbook().updated_by,'system');
});

test('an empty body after the colon asks for the text instead of saving nothing',async t=>{
  const f=fixture(t);
  const result=await f.run(f.event('حدّث تعليمات السكرتير:   '));
  assert.equal(result.status,'clarify');
  assert.equal(f.playbook().updated_by,'system');
});

test('cancelling the update preview leaves the stored instructions untouched',async t=>{
  const f=fixture(t);
  await f.run(f.event('غيّر تعليمات السكرتير: نص لن يُحفظ'));
  const cancelled=await f.run(f.event('إلغاء'));
  assert.equal(cancelled.status,'cancelled');
  assert.equal(f.playbook().updated_by,'system');
  const stillDefault=await f.run(f.event('تعليمات السكرتير'));
  assert.match(stillDefault.reply,/تعليمات مهمة لكل الفريق/);
});

// Same class of bug as the team-reminders trigger: this direct-intercept's
// own INSERT INTO secretary_pending had no guard against a still-unconfirmed
// preview left over from an unrelated prior command, so it used to crash
// with an unhandled SQLite UNIQUE-constraint error instead of replying.
test('an unconfirmed preview from an unrelated command never crashes this trigger -- it just gets replaced',async t=>{
  const f=fixture(t);
  const messagePreview=await f.run(f.event('ابعت لخالد: لا تنسى الفاتورة'),async()=>{const p={...emptySecretaryIntent('message_team'),recipientIds:['member']};p.fields.body='لا تنسى الفاتورة';return p;});
  assert.equal(messagePreview.status,'confirmation');
  const playbookPreview=await f.run(f.event('حدّث تعليمات السكرتير: نص بديل بعد ترك رسالة معلّقة'));
  assert.equal(playbookPreview.status,'confirmation');
  const applied=await f.run(f.event('موافق'));
  assert.equal(applied.status,'applied');
  assert.equal(f.playbook().body,'نص بديل بعد ترك رسالة معلّقة');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agent_outbox WHERE to_user='member'").get().n,0,'the superseded team message must never have gone out');
});
