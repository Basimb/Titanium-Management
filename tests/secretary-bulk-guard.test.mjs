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
    INSERT INTO projects VALUES('p1','تجربه السكرتير','active','باسم',1,NULL,NULL,NULL),('p2','تصليح السيارة','active','باسم',1,NULL,NULL,NULL),
      ('p3','بوت صيدلية تيتانيوم','active','باسم',1,NULL,NULL,NULL),('p4','مشروع اختبار داخلي - تجاهل','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('stale','p1','مهمة تجريبية للتأكد من تحديث النظام','تفاصيل','yellow','open','باسم','باسم',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  let sequence=0,now=Date.parse('2026-09-08T13:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'}],allowedGroupIds:['12345@g.us']};
  const event=(text,extra={})=>({messageId:`BG-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text,receivedAt:now,...extra});
  const run=(e,infer=async()=>{throw Error('a bulk-plural request must be caught before the model is ever consulted');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  return {db,event,run,get now(){return now;}};
}

test('a plural bulk close/archive/delete request is refused with a clarify instead of guessing a single target', async t => {
  const f = fixture(t);
  // Exactly Basim's real report: "the last four, close them" -- with no
  // per-item names, this must never fall back to some unrelated stale task
  // (like the leftover "مهمة تجريبية للتأكد من تحديث النظام" seeded above).
  const result = await f.run(f.event('اخر اربعه قفلهم'));
  assert.equal(result.status, 'clarify');
  assert.match(result.reply, /أكثر من مشروع أو مهمة/);
  assert.doesNotMatch(result.reply, /مهمة تجريبية/);
});

test('other bulk-plural verbs (archive/delete/open/stop) trigger the same guard', async t => {
  const f = fixture(t);
  for (const text of ['ارشفهم كلهم', 'احذفهم', 'امسحهم من القائمة', 'افتحهم كلهم', 'وقفهم لحالهم', 'سكرهم بسرعة']) {
    const result = await f.run(f.event(text));
    assert.equal(result.status, 'clarify', text);
    assert.match(result.reply, /أكثر من مشروع أو مهمة/, text);
  }
});

test('a singular, explicitly named request is unaffected and still reaches the model', async t => {
  const f = fixture(t);
  const chat = async () => emptySecretaryIntent('chat', 'تمام، قفلت مشروع تصليح السيارة.');
  const result = await f.run(f.event('اقفل مشروع تصليح السيارة'), chat);
  assert.equal(result.reply, 'تمام، قفلت مشروع تصليح السيارة.');
});

test('the guard applies to any actor, not just the admin', async t => {
  const f = fixture(t);
  const result = await f.run(f.event('قفلهم', { senderNumber: '12025550101' }));
  assert.equal(result.status, 'clarify');
  assert.match(result.reply, /أكثر من مشروع أو مهمة/);
});
