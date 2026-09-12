// 2026-09-12, Basim's live reaction to the plain-text "unowned task" nudge
// (agent-followups.ts's planFollowups, unowned_task branch): "وهاي التنبهات
// قلتلك تيجي تصويت مش هيك نصوص ارجع عدلها كمان" (and these alerts, I told
// you they should come as a poll, not text like this -- go fix them too).
// unownedTaskPoll (agent-followups.ts) now attaches a real tappable poll to
// that nudge: each active colleague's name reassigns the task straight to
// them (pending their own claim, same as "عيّنها لـ..." today), and a
// dedicated "تولاها بنفسك" option claims it for Basim immediately (he's
// admin, so a bare "claim" sets him as owner outright, no acceptance step).
// This file covers parseUnownedTaskPollChoice/its resolution branch in
// lib/secretary-service.ts -- the deterministic tap-side of that poll, never
// touching the model, exactly like parseApprovalPollChoice/
// parseTaskCloseDecisionPollChoice's own tap branches already work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const OPEN = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('${OPEN}','مهمة بلا موظف','','red','open',NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }, { userId: 'other', number: '12025550102' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: '12025550103', groupId: null, text: 'شو مهامي؟', receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (extra = {}, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => { throw new Error('a poll tap must resolve directly, never ask the model'); }), now: () => now });
  return { db, config, event, run, now };
}
function tap(questionId, optionId) { return { choice: { questionId, optionId } }; }

test('tapping a colleague\'s name reassigns the task to them (pending their own claim), never asking the model', async t => {
  const f = fixture(t);
  const r = await f.run(tap(`UNOWNQ${OPEN}`, `UNOWN${OPEN}_member`));
  assert.equal(r.status, 'applied');
  const task = f.db.prepare('SELECT status, owner AS owner, suggested_owner AS suggestedOwner FROM tasks WHERE id=?').get(OPEN);
  assert.equal(task.status, 'open');
  assert.equal(task.owner, null);
  assert.equal(task.suggestedOwner, 'خالد');
});

test('tapping "تولاها بنفسك" (SELF) claims the task for Basim immediately -- he is admin, so no separate acceptance step', async t => {
  const f = fixture(t);
  const r = await f.run(tap(`UNOWNQ${OPEN}`, `UNOWN${OPEN}_SELF`));
  assert.equal(r.status, 'applied');
  const task = f.db.prepare('SELECT status, owner AS owner FROM tasks WHERE id=?').get(OPEN);
  assert.equal(task.status, 'progress');
  assert.equal(task.owner, 'باسم');
});

test('the poll is refused cleanly (never asking the model or throwing) if the task already got an owner or a suggested owner before the tap landed', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE tasks SET suggested_owner=? WHERE id=?').run('شادي', OPEN);
  const r = await f.run(tap(`UNOWNQ${OPEN}`, `UNOWN${OPEN}_member`));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /شادي/);
  const task = f.db.prepare('SELECT suggested_owner AS suggestedOwner FROM tasks WHERE id=?').get(OPEN);
  assert.equal(task.suggestedOwner, 'شادي', 'the earlier assignment must survive untouched');
});

test('a tap for a task removed since the poll was sent is denied cleanly instead of throwing', async t => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM tasks WHERE id=?').run(OPEN);
  const r = await f.run(tap(`UNOWNQ${OPEN}`, `UNOWN${OPEN}_SELF`));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عادت متاحة/);
});

test('this poll only ever resolves for Basim himself in his own private chat -- anyone else tapping it (or from a group) falls through untouched', async t => {
  const f = fixture(t);
  const r = await f.run({ ...tap(`UNOWNQ${OPEN}`, `UNOWN${OPEN}_SELF`), senderNumber: '12025550101' }, async () => emptySecretaryIntent('summary'));
  const task = f.db.prepare('SELECT status, owner AS owner FROM tasks WHERE id=?').get(OPEN);
  assert.equal(task.status, 'open', 'must not have been claimed by anyone but Basim via this poll');
  assert.equal(task.owner, null);
});
