import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('old','مهمة حالية','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);let sequence=0,now=Date.parse('2026-09-05T13:00:00Z');
  const config={enabled:true,sharedKey:'ab'.repeat(32),contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'}],allowedGroupIds:['12345@g.us']};
  const event=(text,extra={})=>({messageId:`PLAIN-${++sequence}`,responseMessageId:`REPLY-${sequence}`,senderNumber:'12025550103',groupId:null,text,receivedAt:now,...extra});
  const run=(e,infer=async()=>{throw Error('confirmation must not invoke the provider');})=>handleSecretaryEvent(db,e,config,{infer,now:()=>now});
  const pending=()=>db.prepare('SELECT * FROM secretary_pending').get();
  const view=()=>db.prepare('SELECT * FROM secretary_confirmation_views').get();
  const priority=()=>db.prepare("SELECT priority FROM tasks WHERE id='old'").get().priority;
  const preview=async(priority='green',extra={})=>{const p=emptySecretaryIntent('command');return run(event('عدل أولوية المهمة الحالية',extra),async()=>({...p,action:'edit_task',taskId:'old',fields:{...p.fields,priority}}));};
  return {db,event,run,pending,view,priority,preview,get now(){return now;},tick:n=>{now+=n;}};
}

test('fresh visible proposal accepts a separate plain approval, hides its internal code, and executes once',async t=>{
  const f=fixture(t);const preview=await f.preview();const token=f.pending().token;
  assert.equal(preview.status,'confirmation');assert.match(preview.reply,/«موافق»/);assert.doesNotMatch(preview.reply,new RegExp(token));assert.equal(f.priority(),'red');
  const approval=f.event('موافق');assert.equal((await f.run(approval)).status,'applied');assert.equal(f.priority(),'green');assert.equal(f.pending(),undefined);assert.equal(f.view(),undefined);
  assert.equal((await f.run(approval)).status,'duplicate');assert.equal((await f.run({...approval,text:'نعم'})).status,'denied');
});

test('read-only color list intervening after preview does not block the pending approval',async t=>{
  const f=fixture(t);await f.preview();
  assert.equal((await f.run(f.event('المهام الحمراء'))).status,'summary');
  assert.equal(f.priority(),'red');
  assert.equal((await f.run(f.event('موافق'))).status,'applied');assert.equal(f.priority(),'green');
});

test('clarification does not authorize the earlier action, but a quote of that current proposal remains valid',async t=>{
  const f=fixture(t);await f.preview('green',{responseMessageId:'CURRENT-PREVIEW'});
  await f.run(f.event('شو يعني؟'),async()=>emptySecretaryIntent('chat','المقصود تغيير أولوية المهمة فقط.'));
  assert.equal(f.priority(),'red');assert.equal((await f.run(f.event('موافق',{replyToMessageId:'CURRENT-PREVIEW'}))).status,'applied');
});

test('plain approval after replacing A by B executes the current pending (B), never the old one',async t=>{
  const f=fixture(t);await f.preview('green',{responseMessageId:'PREVIEW-A'});const tokenA=f.pending().token;
  await f.preview('yellow',{responseMessageId:'PREVIEW-B'});const tokenB=f.pending().token;assert.notEqual(tokenA,tokenB);
  assert.equal((await f.run(f.event('موافق'))).status,'applied');assert.equal(f.priority(),'yellow');
});

test('old token and quote cannot approve a replacement; quote of B can approve exact B',async t=>{
  const f=fixture(t);await f.preview('green',{responseMessageId:'PREVIEW-A'});const a=f.pending().token;await f.preview('yellow',{responseMessageId:'PREVIEW-B'});
  for(const e of [f.event(`موافق ${a}`),f.event('نعم',{replyToMessageId:'PREVIEW-A'})]){const r=await f.run(e);assert.equal(r.status,'clarify');assert.doesNotMatch(r.reply,/T[0-9A-F]{6}/);assert.equal(f.priority(),'red');}
  assert.equal((await f.run(f.event('موافق',{replyToMessageId:'PREVIEW-B'}))).status,'applied');assert.equal(f.priority(),'yellow');
});

test('legacy pending proposals without a recorded confirmation view still execute on plain approval',async t=>{
  const f=fixture(t);await f.preview();
  f.db.exec('DELETE FROM secretary_confirmation_views');
  assert.equal((await f.run(f.event('موافق'))).status,'applied');assert.equal(f.priority(),'green');
});

test('expiry and changed snapshot are checked before accepting or restating bare approval',async t=>{
  for(const mutate of [f=>f.tick(600001),f=>f.db.exec("UPDATE tasks SET updated_at=2 WHERE id='old'")]){
    const f=fixture(t);await f.preview();mutate(f);const result=await f.run(f.event('موافق'));
    assert.equal(result.status,'stale');assert.equal(f.priority(),'red');assert.equal(f.pending(),undefined);assert.equal(f.view(),undefined);assert.doesNotMatch(result.reply,/T[0-9A-F]{6}/);
  }
});

test('cross-actor, group, disabled actor and cancellation never borrow private approval authority',async t=>{
  const f=fixture(t);await f.preview();
  for(const extra of [{senderNumber:'12025550101'},{groupId:'12345@g.us'}]){await f.run(f.event('موافق',extra));assert.equal(f.priority(),'red');assert.ok(f.pending());}
  f.db.exec("UPDATE users SET active=0 WHERE id='basem'");assert.equal((await f.run(f.event('موافق'))).status,'denied');assert.equal(f.priority(),'red');
  f.db.exec("UPDATE users SET active=1 WHERE id='basem'");assert.equal((await f.run(f.event('إلغاء'))).status,'cancelled');assert.equal(f.view(),undefined);
  assert.equal((await f.run(f.event('موافق'))).status,'summary');assert.equal(f.priority(),'red');
});

test('team preview preserves exact text including user text that resembles a token; plain approval queues only',async t=>{
  const f=fixture(t);const p=emptySecretaryIntent('message_team');const body='اجتماع تجريبي، والنص الحرفي «موافق TABCDEF» ضمن الرسالة.';
  const e=f.event('ابعث لخالد النص التجريبي');const preview=await f.run(e,async()=>({...p,recipientIds:['member'],fields:{...p.fields,body}}));
  assert.ok(preview.reply.includes(body));assert.ok((await f.run(e)).reply.includes(body));assert.doesNotMatch(preview.reply,new RegExp(f.pending().token));
  assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_outbox_deliveries').get().n,0);
  assert.equal((await f.run(f.event('موافق'))).status,'queued');assert.equal(f.db.prepare('SELECT body FROM secretary_outbox_batches').get().body,body);
  assert.equal(f.db.prepare("SELECT count(*) n FROM secretary_outbox_deliveries WHERE state='queued'").get().n,1);
});

test('voice updates still require a displayed proposal and separate plain approval',async t=>{
  const f=fixture(t);const p=emptySecretaryIntent('command');
  const preview=await f.run(f.event('سجل تحديث وصل المورد',{inputKind:'voice'}),async()=>({...p,action:'comment',taskId:'old',fields:{...p.fields,body:'وصل المورد'}}));
  assert.equal(preview.status,'confirmation');assert.match(preview.reply,/فهمت من الصوت/);assert.doesNotMatch(preview.reply,new RegExp(f.pending().token));assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
  assert.equal((await f.run(f.event('موافق'))).status,'applied');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,1);
});

test('failed receipt persistence rolls back the action, pending deletion and visible-preview binding together',async t=>{
  const f=fixture(t);await f.preview();const before={...f.pending()},view={...f.view()};
  f.db.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON secretary_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  const event=f.event('موافق');await assert.rejects(f.run(event),/synthetic failure/);assert.equal(f.priority(),'red');assert.deepEqual({...f.pending()},before);assert.deepEqual({...f.view()},view);
  f.db.exec('DROP TRIGGER fail_approval');assert.equal((await f.run(event)).status,'applied');assert.equal(f.priority(),'green');
});
