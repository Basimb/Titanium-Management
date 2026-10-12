// Basim, 2026-10-12: «خليه يفهم كل شي ويحلل الكلام خلص مش على اساس طورته».
// Free text while a poll is open, free timed reminders, and replies to the
// one-off messages the secretary sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary, looksLikePollAnswer, isShortAck } from '../lib/secretary-service.ts';
import { emptySecretaryIntent, validateSecretaryIntent } from '../lib/secretary-intent.ts';
import { migrateAgentSchema } from '../lib/agent-schema.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = 1788580000000;

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('khaled','خالد','member',1,NULL,1,1);
    INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
      ('${A}','معالجة فتحات غرف المنامة','','red','progress','خالد','خالد',1,1,1),
      ('${B}','الديكور واللوحة وتعديل كونتر الاستقبال','','yellow','progress','خالد','خالد',1,2,2);`);
  migrateSecretary(db); migrateAgentSchema(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'khaled', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0;
  const never = async () => { assert.fail('must resolve in code'); };
  const say = (text, infer = never, sender = '12025550101') => handleSecretaryEvent(db,
    { messageId: `E-${++count}`, senderNumber: sender, groupId: null, text, receivedAt: now, responseMessageId: `R-${count}` },
    config, { infer, now: () => now });
  return { db, say };
}
const outbox = (db, to) => db.prepare('SELECT * FROM agent_outbox WHERE to_user=? ORDER BY created_at').all(to);

test('poll-answer detector: numbers, labels, yes/no and task verbs wait; real sentences pass', () => {
  const choices = { id: 'Q', title: 'x', expiresAt: now + 1e6, options: [{ id: '1', label: 'معالجة فتحات غرف المنامة' }, { id: 'N', label: 'لا شي' }] };
  for (const text of ['2', '٣', 'رقم 4', 'تمام', 'موافق', 'لا', 'معالجة فتحات غرف المنامة', 'خلصت', 'بدي استلم', '']) assert.equal(looksLikePollAnswer(text, choices), true, text);
  for (const text of ['شو مبيعات اليوم', 'ذكرني الساعة 5 العصر اتصل بالمورد', 'مين بعتلي هاي الرسالة؟']) assert.equal(looksLikePollAnswer(text, choices), false, text);
});

test('a real sentence typed while a poll is open is understood; the poll stays for a tap', async t => {
  const f = fixture(t);
  const asked = await f.say('انهاء المهمة');
  assert.ok(asked.choices);
  let seen = null;
  const reply = await f.say('شو أخبار الدوام بكرا؟', async input => { seen = input; return emptySecretaryIntent('chat', 'الدوام عادي إن شاء الله.'); });
  assert.ok(seen, 'the model read it');
  assert.match(reply.reply, /الدوام عادي/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n, 1, 'the question still stands');
});

test('...but if the sentence turns out to be a task action, the open poll comes first', async t => {
  const f = fixture(t);
  await f.say('انهاء المهمة');
  f.db.prepare("INSERT OR REPLACE INTO secretary_open_choice VALUES('khaled',?,?,0)").run(JSON.stringify({ id: 'Q', title: 'x', expiresAt: now + 1e6, options: [{ id: '1', label: 'أ' }] }), now + 1e6);
  const reply = await f.say('اكتب على الديكور ملاحظة انه الدهان وصل', async () => ({ ...emptySecretaryIntent('command'), action: 'comment', taskId: B, fields: { ...emptySecretaryIntent().fields, body: 'الدهان وصل' } }));
  assert.match(reply.reply, /اختار من القائمة/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
});

test('free reminder is queued for the stated time, echoed back, and not sent early', async t => {
  const f = fixture(t);
  const at = new Date(now + 3 * 3600_000).toISOString();
  const reply = await f.say('ذكرني بعد 3 ساعات ابعت الطلبية', async () => ({ ...emptySecretaryIntent('free_reminder'), fields: { ...emptySecretaryIntent().fields, body: 'ابعت الطلبية', remindAt: at } }));
  assert.equal(reply.status, 'scheduled');
  assert.match(reply.reply, /رح أذكرك/);
  assert.match(reply.reply, /ابعت الطلبية/);
  const rows = outbox(f.db, 'khaled');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deliver_after, now + 3 * 3600_000);
  assert.equal(rows[0].source, 'reminder');
  assert.match(rows[0].text, /⏰ تذكير: ابعت الطلبية/);
});

test('free reminder in the past or without an offset is asked again', async t => {
  const f = fixture(t);
  const past = await f.say('ذكرني', async () => ({ ...emptySecretaryIntent('free_reminder'), fields: { ...emptySecretaryIntent().fields, body: 'x', remindAt: new Date(now - 60_000).toISOString() } }));
  assert.equal(past.status, 'clarify');
  const input = { text: 'ذكرني', actor: { id: 'khaled', name: 'خالد', role: 'member' }, tasks: [], users: [], history: [], now: new Date(now).toISOString() };
  const plan = validateSecretaryIntent({ ...emptySecretaryIntent('free_reminder'), fields: { ...emptySecretaryIntent().fields, body: 'x', remindAt: '2026-10-12T17:00:00' } }, input);
  assert.equal(plan.kind, 'clarify');
  assert.equal(outbox(f.db, 'khaled').length, 0);
});

test('a short "تمام" after a one-off message is acknowledged and Basim is told once', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO agent_outbox (id,to_user,text,state,created_at,sent_at) VALUES ('o1','khaled','كلم المورد بخصوص الحفاضات','sent',?,?)").run(now - 600_000, now - 600_000);
  assert.equal(isShortAck('تمام دكتور'), true);
  assert.equal(isShortAck('👍'), true);
  assert.equal(isShortAck('تمام بس المورد مسكر اليوم'), false);
  const reply = await f.say('تمام');
  assert.match(reply.reply, /وصلني ردك/);
  const basim = outbox(f.db, 'basem');
  assert.equal(basim.length, 1);
  assert.match(basim[0].text, /خالد ردّ على رسالة/);
  assert.match(basim[0].text, /تمام/);
  // The second ack does not notify again (falls to the ordinary path).
  await f.say('تمام');
  assert.equal(outbox(f.db, 'basem').length, 1);
});

test('the model sees recent outbound messages and can answer about them', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO agent_outbox (id,to_user,text,state,created_at,sent_at) VALUES ('o1','khaled','الأسعار الجديدة للحفاضات انعدلت','sent',?,?)").run(now - 600_000, now - 600_000);
  let seen = null;
  const reply = await f.say('شو قصدك بهاي الرسالة؟', async input => { seen = input; return { ...emptySecretaryIntent('outbound_reply', 'قصدي إنه أسعار الحفاضات انعدلت بالنظام.'), fields: { ...emptySecretaryIntent().fields, body: 'سؤال عن الرسالة' } }; });
  assert.equal(seen.recentOutbound.length, 1);
  assert.match(seen.recentOutbound[0].text, /حفاضات/);
  assert.match(reply.reply, /أسعار الحفاضات/);
  assert.equal(outbox(f.db, 'basem').length, 1, 'Basim hears about the reply once');
});
