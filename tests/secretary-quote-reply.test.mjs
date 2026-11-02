// باسم 02/11/2026: رد باسم (اقتباس) على «📩 طلب من براء» بيروح لبراءة مباشرة.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { migrateAgentSchema } from '../lib/agent-schema.ts';
import { enqueueAgentMessage, createFollowupJobs } from '../lib/agent-followups.ts';

const now = 1788580000000;
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('baraa','براء','member',1,NULL,1,1);`);
  migrateSecretary(db); migrateAgentSchema(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'baraa', number: '12025550101' }], allowedGroupIds: [] };
  return { db, config };
}

test('Basim quoting a relayed staff request sends his reply to that employee', async t => {
  const { db, config } = fixture(t);
  enqueueAgentMessage(db, { toUser: 'basem', text: '📩 طلب من براء:\nوصلني شكري لدكتور باسم', relayFrom: 'baraa' }, now);
  let sentId;
  const jobs = createFollowupJobs({ db, config: { enabled: true, contacts: config.contacts, groupId: null }, now: () => now });
  const r0 = await jobs.deliverNext(async m => { sentId = m.messageId; });
  assert.equal(r0.status, 'sent');
  const res = await handleSecretaryEvent(db, { messageId: 'E-1', senderNumber: '12025550103', groupId: null, text: 'ارسلها استلمو', receivedAt: now, replyToMessageId: sentId, responseMessageId: 'R-1' },
    config, { infer: async () => assert.fail('must not reach the model'), now: () => now });
  assert.equal(res.status, 'queued');
  assert.match(res.reply, /براء/);
  const out = db.prepare("SELECT text FROM agent_outbox WHERE to_user='baraa'").all();
  assert.equal(out.length, 1);
  assert.match(out[0].text, /د\. باسم/);
  assert.match(out[0].text, /ارسلها استلمو/);
  assert.match(out[0].text, /وصلني شكري/);
  // replay of the same event does not send twice
  await handleSecretaryEvent(db, { messageId: 'E-1', senderNumber: '12025550103', groupId: null, text: 'ارسلها استلمو', receivedAt: now, replyToMessageId: sentId, responseMessageId: 'R-1' },
    config, { infer: async () => assert.fail('no'), now: () => now });
  assert.equal(db.prepare("SELECT count(*) n FROM agent_outbox WHERE to_user='baraa'").get().n, 1);
});

test('a staff member quoting a message is not routed', async t => {
  const { db, config } = fixture(t);
  enqueueAgentMessage(db, { toUser: 'basem', text: '📩 طلب من براء:\nx', relayFrom: 'baraa' }, now);
  db.prepare("UPDATE agent_outbox SET wa_message_id='3EB0AA', state='sent'").run();
  await handleSecretaryEvent(db, { messageId: 'E-2', senderNumber: '12025550101', groupId: null, text: 'شو صار', receivedAt: now, replyToMessageId: '3EB0AA', responseMessageId: 'R-2' },
    config, { infer: async () => ({ kind: 'clarify', message: 'ok', recipientIds: [], fields: {} }), now: () => now }).catch(() => {});
  assert.equal(db.prepare("SELECT count(*) n FROM agent_outbox WHERE to_user='baraa'").get().n, 0);
});
