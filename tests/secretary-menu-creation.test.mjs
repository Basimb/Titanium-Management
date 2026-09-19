// Basim, 2026-09-19: "جيت افتح مهمه ولقيتو سالني عن اللي فاتحها الصبح مع انه
// اعلن وخلصها ورجع نشرها كمان مره". He tapped "1" to open a NEW task and the
// assistant answered with a finished confirmation for "برمجة كاميرات دابوق" --
// the task he had already opened that morning -- which he then confirmed,
// leaving two identical open tasks for خالد three hours apart (audit ids 800
// and its 12:36 twin on the live database). "1" is rewritten to the bare words
// "اضافة مهمة", so the message carries no work at all: the title could only
// have come from the 24-hour history the model is shown. A contentless
// creation request must therefore never reach the model -- it opens an empty
// draft and asks what the work is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';

const MORNING = '44444444-4444-4444-8444-444444444444';
// What the model did on the live system: asked for a brand-new task with a
// contentless message, it recited that morning's task back, complete.
const RECONSTRUCTED = {
  kind: 'task_draft', intakeMode: 'start', action: null, taskId: null, recipientIds: [], message: null,
  fields: { title: 'برمجة كاميرات دابوق', details: null, ownerId: 'member', priority: 'yellow', dueDate: '2026-09-24',
    name: null, reason: null, body: null, remindAt: null, status: null },
};

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,created_at,updated_at)
      VALUES('${MORNING}','برمجة كاميرات دابوق','','yellow','open',NULL,'خالد',1,1);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const run = (text, infer) => handleSecretaryEvent(db,
    { messageId: `EVENT-${++count}`, senderNumber: '12025550103', groupId: null, text, receivedAt: now, responseMessageId: `REPLY-${count}` },
    config, { infer, now: () => now });
  return { db, run };
}
const taskCount = db => db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
const draftRow = db => db.prepare('SELECT draft_json FROM secretary_task_intake').get();

test('a task opened from the menu starts empty, even when the model recites this morning\'s task', async t => {
  const f = fixture(t);
  const reply = await f.run('1', async () => { assert.fail('a menu tap must open a task without asking the model'); });
  assert.equal(reply.status, 'clarify');
  assert.match(reply.reply, /الشغل المطلوب/, 'it asks what the work is');
  assert.doesNotMatch(reply.reply, /كاميرات/, 'and never offers the old task back as the new one');
  const draft = JSON.parse(draftRow(f.db).draft_json);
  assert.equal(draft.title ?? null, null);
  assert.equal(draft.ownerId ?? null, null);
  assert.equal(draft.dueDate ?? null, null);
  assert.equal(taskCount(f.db), 1, 'nothing is created, and nothing is duplicated');
});

test('typing the same words is left alone -- there the person really did write them', async t => {
  const f = fixture(t);
  const reply = await f.run('اضافة مهمة', async () => RECONSTRUCTED);
  // Not a menu tap, so the plan stands: the draft keeps what the model gave.
  assert.match(JSON.stringify(reply), /كاميرات/);
});

// The second half of the same morning: with no draft open, his answer to the
// question -- the title itself -- has nowhere to land, so the start guard
// bounces it back. He sent the same title three times and got the same
// sentence three times. The draft now exists before the question is asked.
test('the title he answers with lands in the draft the tap opened', async t => {
  const f = fixture(t);
  await f.run('1', async () => { assert.fail('a menu tap must open a task without asking the model'); });
  const reply = await f.run('عمل لوجو العيادات من الداخل', async () => { assert.fail('the only missing field is the title; the model is not consulted'); });
  assert.doesNotMatch(reply.reply, /بدك أضيف مهمة جديدة؟/, 'it must not bounce the answer back as a fresh question');
  assert.match(reply.reply, /مين بدك/, 'it moves on to the next missing field');
  assert.equal(JSON.parse(draftRow(f.db).draft_json).title, 'عمل لوجو العيادات من الداخل');
});
