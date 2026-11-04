// باسم 04/11/2026 «اقرا ردودك اخر يومين… وطور نفسك»: اللي انصلّح من مراجعة ردود أمين على الموظفين.
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
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('kh','خلود','member',1,NULL,1,1);`);
  migrateSecretary(db); migrateAgentSchema(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'kh', number: '12025550101' }], allowedGroupIds: [] };
  let n = 0;
  const say = (text, infer, extra = {}, deps = {}) => handleSecretaryEvent(db, { messageId: `E-${++n}`, senderNumber: '12025550101', groupId: null, text, receivedAt: now + n * 1000, responseMessageId: `R-${n}`, ...extra },
    config, { infer, ownerDeliveryEnabled: true, now: () => now + n * 1000, ...deps });
  const toBasem = () => db.prepare("SELECT text FROM agent_outbox WHERE to_user='basem'").all();
  return { db, say, toBasem };
}
const ownerMsg = (body, extra = {}) => ({ ...emptySecretaryIntent('owner_message'), fields: { ...emptySecretaryIntent().fields, body, ...extra } });

test('«اه» to Amin\'s own «بدك أرفعها لباسم؟» sends ONE complete message (Kholoud 03/11)', async t => {
  const f = fixture(t);
  await f.say('8805178180217 ستوك 1 سستم 0', async () => emptySecretaryIntent('clarify', 'سجّلت عندي: الباركود 8805178180217، على الرف 1 والسيستم 0 (فرع دابوق). بدك أرفعها لباسم بهالتفاصيل؟'));
  const res = await f.say('اه', async () => ownerMsg('اه'));
  assert.equal(res.status, 'queued');
  assert.match(res.reply, /بعتتها لد\. باسم/);
  const out = f.toBasem();
  assert.equal(out.length, 1);
  assert.match(out[0].text, /8805178180217/);
});

test('an explicit owner_message with extra fields filled is still sent', async t => {
  const f = fixture(t);
  const res = await f.say('ارسل لباسم انه الصنف ناقص', async () => ownerMsg('الصنف ناقص — خلود', { reason: 'نقص' }));
  assert.equal(res.status, 'queued');
  assert.equal(f.toBasem().length, 1);
});

test('a «ليش» question mentioning the jard reaches Amin, not the link list', async t => {
  const f = fixture(t);
  let asked = false;
  const res = await f.say('طيب ليش تبعتلي تنبيه ما دام أن الجرد اللي انبعتلي خلصته', async () => { asked = true; return emptySecretaryIntent('clarify', 'التنبيه بيطلع لما…'); });
  assert.equal(asked, true);
  assert.match(res.reply, /التنبيه/);
});

test('«خلصتها» no longer answers «ما عندك مهمة»', async t => {
  const f = fixture(t);
  const res = await f.say('خلصتها', async () => emptySecretaryIntent('clarify', 'شو اللي خلصتيه؟ الدورة؟'));
  assert.doesNotMatch(res.reply, /مهمة قيد التنفيذ/);
});

test('an image is read and reaches Amin as part of the employee\'s message', async t => {
  const f = fixture(t);
  let seen;
  const res = await f.say('هاد الصنف', async input => { seen = input.text; return emptySecretaryIntent('clarify', 'تمام، Panadol Extra 24 tab — كم عالرف؟'); },
    { imageFile: '/home/titani24/.titanium-team-chat/media/12025550101/20261104-110000_ABC123.jpg' },
    { describeImage: async () => 'علبة Panadol Extra 24 tab، باركود 5000158062214' });
  assert.match(seen, /هاد الصنف/);
  assert.match(seen, /Panadol Extra/);
  assert.match(res.reply, /Panadol/);
});

test('an image path outside the media folder is refused', async t => {
  const f = fixture(t);
  const res = await f.say('صورة', async () => assert.fail('no'), { imageFile: '/etc/passwd' }, { describeImage: async () => 'x' });
  assert.equal(res.status, 'denied');
});

test('a long stocktake question (Jood 04/11, offer pack) reaches Amin, not the link list', async t => {
  const f = fixture(t);
  let asked = false;
  await f.say('مطلوب مني جرد حليب sahha 3 pro حجم ال ٤٠٠ / انا عندي علبتين ع الرف وفي كمان العرض العلبتين مع بعض العرض بحسبو ضمن الجرد،', async () => { asked = true; return emptySecretaryIntent('clarify', 'سؤال منيح'); });
  assert.equal(asked, true);
});

test('«نعم» with only an expired old confirmation goes on normally, no «انتهى وقت الطلب» (Basim 05/11)', async t => {
  const f = fixture(t);
  await f.say('مرحبا', async () => emptySecretaryIntent('clarify', 'هلا، شو بدك؟'));
  const key = f.db.prepare('SELECT conversation_key k FROM secretary_events LIMIT 1').get()?.k;
  assert.ok(key);
  f.db.prepare('INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)').run(key, 'TOK', '{"action":"team_reminders"}', 'h', 'x', 'm', now - 31 * 60_000);
  let asked = false;
  const res = await f.say('نعم', async () => { asked = true; return emptySecretaryIntent('clarify', 'تمام، كمّل'); });
  assert.doesNotMatch(res.reply, /انتهى وقت الطلب/);
});
