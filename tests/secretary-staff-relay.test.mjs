// Basim, 2026-10-25: «طبق بالشكل الصحيح». Mohammad Eyad answered Amin's
// numbered 4-card reminder with «امين ٤ و ٣ حولهم على شادي بدي اسعار تكلفتهم»;
// Amin read 3/4 as task numbers, could not relay to Shadi, and lost his «نعم».
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
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('eyad','محمد إياد','member',1,NULL,1,1),('shadi','شادي','member',1,NULL,1,1);`);
  migrateSecretary(db); migrateAgentSchema(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'eyad', number: '12025550101' }, { userId: 'shadi', number: '12025550102' }], allowedGroupIds: [] };
  db.prepare("INSERT INTO agent_outbox (id,to_user,text,state,created_at,sent_at) VALUES ('o1','eyad',?,'sent',?,?)").run(
    'تذكير بالأربع كروت:\n1. VASELINE BODY OIL 200ML #91213\n2. LINK 36 20MG #90589 / #90590\n3. PHARMAPORE 10*25 #84463 / #84464\n4. DRESSING BANDAGE 9*20 #85690\n\nرد علي شو عملت بكل واحد', now - 46 * 60_000, now - 46 * 60_000);
  let count = 0;
  const say = (text, infer, sender = '12025550101') => handleSecretaryEvent(db,
    { messageId: `E-${++count}`, senderNumber: sender, groupId: null, text, receivedAt: now, responseMessageId: `R-${count}` },
    config, { infer: infer ?? (async () => assert.fail('must resolve in code')), now: () => now });
  return { db, say };
}
const outbox = (db, to) => db.prepare("SELECT * FROM agent_outbox WHERE to_user=? AND id<>'o1' ORDER BY created_at").all(to);

test('numbers resolve to the list Amin sent; relay previews once by name, «نعم» queues it to Shadi', async t => {
  const f = fixture(t);
  let seen = null;
  const preview = await f.say('امين ٤ و ٣ حولهم على شادي بدي اسعار تكلفتهم', async input => {
    seen = input;
    return { ...emptySecretaryIntent('staff_relay'), recipientIds: ['shadi'], fields: { ...emptySecretaryIntent().fields, body: 'بدنا تكلفة PHARMAPORE 10*25 و DRESSING BANDAGE 9*20' } };
  });
  assert.equal(seen.canRelayToStaff, true);
  assert.deepEqual(seen.outboundListReference.mentioned.sort(), [3, 4]);
  assert.match(seen.outboundListReference.resolved, /PHARMAPORE/);
  assert.match(seen.outboundListReference.resolved, /DRESSING/);
  assert.equal(preview.status, 'confirmation');
  assert.match(preview.reply, /شادي/);
  assert.ok(preview.choices);
  assert.equal(outbox(f.db, 'shadi').length, 0, 'nothing sent before yes');
  const done = await f.say('نعم');
  assert.equal(done.status, 'queued');
  const sent = outbox(f.db, 'shadi');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /محمد إياد/);
  assert.match(sent[0].text, /PHARMAPORE/);
});

test('«لا» cancels the relay preview and nothing is sent', async t => {
  const f = fixture(t);
  await f.say('حولهم على شادي ٣ و ٤', async () => ({ ...emptySecretaryIntent('staff_relay'), recipientIds: ['shadi'], fields: { ...emptySecretaryIntent().fields, body: 'تكلفة البندين' } }));
  await f.say('لا');
  assert.equal(outbox(f.db, 'shadi').length, 0);
});

test('a bare «نعم» right after Amin asked a question goes back to the model with history', async t => {
  const f = fixture(t);
  await f.say('بدي أحكي مع حدا', async () => emptySecretaryIntent('clarify', 'مع مين بدك تحكي؟'));
  let reached = false;
  const r = await f.say('نعم', async () => { reached = true; return emptySecretaryIntent('chat', 'تمام.'); });
  assert.equal(reached, true, 'the model saw the yes');
  assert.doesNotMatch(r.reply, /احكيلي كيف أقدر أساعدك/);
});

test('Basim cannot use staff_relay (he has message_team); a relay to Basim is refused', async t => {
  const f = fixture(t);
  let seen = null;
  await f.say('شو الأخبار', async input => { seen = input; return emptySecretaryIntent('chat', 'تمام'); }, '12025550103');
  assert.equal(seen.canRelayToStaff, false);
  const r = await f.say('وصّل لباسم', async () => ({ ...emptySecretaryIntent('staff_relay'), recipientIds: ['basem'], fields: { ...emptySecretaryIntent().fields, body: 'x' } }));
  assert.equal(r.status, 'clarify');
  assert.equal(outbox(f.db, 'basem').filter(m => /عن طريق أمين/.test(m.text)).length, 0);
});
