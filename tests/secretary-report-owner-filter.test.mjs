import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

// "مهام خالد" used to hand back a full management report (everyone's tasks)
// instead of only خالد's -- Basim's explicit complaint. These tests exercise
// the fix through the same handleSecretaryEvent harness other secretary
// tests use, with a mocked `infer` standing in for the model call.
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
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('q','مشروع آخر','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('t-khaled','p','مهمة خالد','تفاصيل','red','progress','خالد','خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);
    INSERT INTO tasks VALUES('t-khaled-2','q','مهمة خالد الثانية','تفاصيل','green','open',NULL,'خالد',1,NULL,NULL,NULL,1,1,NULL,NULL);
    INSERT INTO tasks VALUES('t-other','p','مهمة شادي','تفاصيل','yellow','open',NULL,'شادي',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  let sequence = 0, now = Date.parse('2026-09-05T08:00:00Z');
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: [] };
  const event = (text, extra = {}) => ({ messageId: `DIRECT-${++sequence}`, responseMessageId: `REPLY-${sequence}`, senderNumber: '12025550103', groupId: null, text, receivedAt: now, ...extra });
  const run = (e, infer = async () => { throw Error('the deterministic flow must not invoke the provider'); }) => handleSecretaryEvent(db, e, config, { infer, now: () => now });
  const reportPlan = ownerId => { const p = emptySecretaryIntent('report'); return { ...p, fields: { ...p.fields, ownerId } }; };
  return { db, event, run, reportPlan };
}

test('"مهام خالد" (report with fields.ownerId) returns only that person\'s tasks, never everyone\'s', async t => {
  const f = fixture(t);
  const r = await f.run(f.event('مهام خالد'), async () => f.reportPlan('member'));
  assert.equal(r.status, 'summary');
  assert.match(r.reply, /ملخص مهام خالد/);
  assert.match(r.reply, /مهمة خالد/);
  assert.match(r.reply, /مهمة خالد الثانية/);
  assert.doesNotMatch(r.reply, /مهمة شادي/);
});

test('a plain management report (no named person) still lists everyone, no project mention at all', async t => {
  const f = fixture(t);
  const r = await f.run(f.event('اعطيني تقرير الإدارة'), async () => f.reportPlan(null));
  assert.equal(r.status, 'summary');
  assert.match(r.reply, /ملخص الإدارة/);
  assert.doesNotMatch(r.reply, /ملخص مهام/);
  assert.doesNotMatch(r.reply, /مشروع/);
  assert.match(r.reply, /مهمة خالد/);
  assert.match(r.reply, /مهمة شادي/);
});

test('an unrecognized ownerId asks who exactly, instead of guessing or dumping everyone', async t => {
  const f = fixture(t);
  const p = emptySecretaryIntent('report');
  const r = await f.run(f.event('مهام شخص غير مسجل'), async () => ({ ...p, fields: { ...p.fields, ownerId: 'ghost' } }));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /مين الموظف المسجّل/);
});
