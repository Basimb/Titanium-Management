// باسم 03/11/2026 (1 و 2): محمد عيد بعت باركود ثم «METFORAL 850» ثم «30 tab» جوابًا على سؤال أمين،
// وكل وحدة انحوّلت لباسم لحالها. هلأ: ما في تحويل بدون طلب صريح، وأمين بيكمّل بنفسه.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';
import { migrateAgentSchema } from '../lib/agent-schema.ts';

const now = 1788580000000;
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('eid','محمد عيد','member',1,NULL,1,1);`);
  migrateSecretary(db); migrateAgentSchema(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'eid', number: '12025550101' }], allowedGroupIds: [] };
  let n = 0;
  const say = (text, infer) => handleSecretaryEvent(db, { messageId: `E-${++n}`, senderNumber: '12025550101', groupId: null, text, receivedAt: now + n, responseMessageId: `R-${n}` },
    config, { infer, ownerDeliveryEnabled: true, now: () => now + n });
  const toBasem = () => db.prepare("SELECT text FROM agent_outbox WHERE to_user='basem'").all();
  return { db, say, toBasem };
}
const ownerMsg = body => ({ ...emptySecretaryIntent('owner_message'), fields: { ...emptySecretaryIntent().fields, body } });

test('a fragment the model wants to forward is not sent to Basim; Amin re-reads it as an answer and replies', async t => {
  const f = fixture(t);
  const seen = [];
  const res = await f.say('METFORAL 850', async input => { seen.push(input); return seen.length === 1 ? ownerMsg('METFORAL 850') : emptySecretaryIntent('clarify', 'تمام، وكم حبة عالرف بالضبط؟'); });
  assert.equal(f.toBasem().length, 0);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].canNotifyOwner, false);
  assert.match(seen[1].text, /جواب على آخر سؤال/);
  assert.match(res.reply, /كم حبة/);
});

test('if the model still wants to forward, nothing goes to Basim and the employee is told how to raise it', async t => {
  const f = fixture(t);
  const res = await f.say('30 tab', async () => ownerMsg('30 tab'));
  assert.equal(f.toBasem().length, 0);
  assert.match(res.reply, /وصّلها لد\. باسم/);
});

test('an explicit ask sends ONE message carrying the whole case', async t => {
  const f = fixture(t);
  await f.say('وصّلها لد. باسم', async () => ownerMsg('METFORAL 850 30 tab (باركود 8012992000298): عالرف 2، على السيستم صفر — فرع ناعور'));
  const out = f.toBasem();
  assert.equal(out.length, 1);
  assert.match(out[0].text, /METFORAL 850/);
  assert.match(out[0].text, /على السيستم صفر/);
});
