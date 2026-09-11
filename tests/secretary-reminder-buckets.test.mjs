// Basim: "لما ترسل له تذكير بالمهام تبعه، تحط اليوم إيش عنده مهام، تحط مثلاً
// بكرة عنده كذا، بعد بكرة عنده كذا، بعد أسبوع عنده كذا" -- a reminder groups
// a person's tasks by when they're due, heading each group with the bucket
// name, instead of one flat numbered list. Covers both the twice-daily auto
// reminder (agent-followups.ts's planFollowups) and the on-demand "ابعت
// تذكير المهام الآن" broadcast (secretary-service.ts's sendTeamTaskReminders).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateManagementActions } from '../lib/management-actions.ts';
import { planFollowups } from '../lib/agent-followups.ts';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function schema(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
`);
}
const t = (id, due) => `('${id}','مهمة ${id}','','yellow','progress','خالد','خالد',1,${due ? `'${due}'` : 'NULL'},NULL,NULL,1,1,NULL,NULL)`;

test('the twice-daily auto reminder buckets by due date, in order, and attaches a poll only for a single-task reminder', async t2 => {
  const db = new DatabaseSync(':memory:'); t2.after(() => db.close());
  schema(db);
  // 2026-09-10 local (Amman) is "today" for the 08:00 slot used below.
  db.exec(`INSERT INTO tasks VALUES
    ${t('late', '2026-09-01')},${t('today', '2026-09-10')},${t('tom', '2026-09-11')},
    ${t('after', '2026-09-12')},${t('week', '2026-09-15')},${t('later', '2026-09-30')},${t('none', null)}`);
  migrateManagementActions(db);
  const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'member', number: '962770000000' }], groupId: '123@g.us' };
  const morning = Date.UTC(2026, 8, 10, 5, 0); // 08:00 Amman
  const plans = planFollowups(db, config, morning).filter(p => p.kind === 'auto_reminder_morning' && p.targetUser === 'member');
  const text = plans[0].text;
  const order = ['🔴 متأخرة', 'اليوم', 'بكرة', 'بعد بكرة', 'خلال أسبوع', 'لاحقًا', 'بدون موعد محدد'].map(label => text.indexOf(`*${label}*`));
  assert.ok(order.every(i => i >= 0), 'every bucket heading must appear');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'buckets must appear in chronological order');
  assert.match(text, /\*🔴 متأخرة\*\n1\. .*مهمة late/);
  assert.equal(plans[0].choices, undefined, 'seven tasks -- too many for one poll to disambiguate');
});

test('a single-task reminder attaches that task\'s own action poll', async t2 => {
  const db = new DatabaseSync(':memory:'); t2.after(() => db.close());
  schema(db);
  db.exec(`INSERT INTO tasks VALUES ${t('solo', '2026-09-11')}`);
  migrateManagementActions(db);
  const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'member', number: '962770000000' }], groupId: '123@g.us' };
  const morning = Date.UTC(2026, 8, 10, 5, 0);
  const plans = planFollowups(db, config, morning).filter(p => p.kind === 'auto_reminder_morning' && p.targetUser === 'member');
  assert.ok(plans[0].choices, 'a reminder naming exactly one task should offer its poll');
  assert.equal(plans[0].choices.id, 'TSKQsolo');
  assert.deepEqual(plans[0].choices.options.map(o => o.id), ['TSKsoloFINISH', 'TSKsoloNOTE', 'TSKsoloTRANSFER', 'TSKsoloEDIT', 'TSKsoloEXTEND']);
});

test('the on-demand "ابعت تذكير المهام الآن" broadcast also buckets by due date', async t2 => {
  const db = new DatabaseSync(':memory:'); t2.after(() => db.close());
  schema(db);
  db.exec(`INSERT INTO tasks VALUES ${t('a', '2026-09-01')},${t('b', '2026-09-30')}`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = Date.parse('2026-09-10T13:00:00Z');
  const event = (extra = {}) => ({ messageId: `E-${++count}`, responseMessageId: `R-${count}`, senderNumber: '12025550103', groupId: null, text: 'ابعت تذكير المهام الآن', receivedAt: now, ...extra });
  const run = (extra, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => { throw Error('must not infer'); }), now: () => now });
  const preview = await run();
  assert.equal(preview.status, 'confirmation');
  const token = db.prepare('SELECT token FROM secretary_pending').get().token;
  const applied = await run({ text: `موافق ${token}` });
  assert.equal(applied.status, 'applied');
  const toMember = db.prepare("SELECT text FROM agent_outbox WHERE to_user='member'").get().text;
  assert.match(toMember, /\*🔴 متأخرة\*/); assert.match(toMember, /\*لاحقًا\*/);
  assert.ok(toMember.indexOf('🔴 متأخرة') < toMember.indexOf('لاحقًا'));
});
