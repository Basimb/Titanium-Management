// Basim (2026-09-16), looking at his own 9am reminder: "مش فاهم ايش هذا؟" --
// the once-a-day "these requests have been waiting more than two days" nudge
// was the last message in the system still asking him to TYPE ("اكتب «اعتمد
// 1»") while every other decision had become a tap. It now carries a real
// poll: one pending request gets its own 🟢/🔴 decision poll straight away,
// several get a picker first (pendingApprovalsPoll in lib/approvals.ts), and
// a tap on the picker answers with that request plus its own decision poll
// (parseApprovalPickerChoice in lib/secretary-service.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateManagementActions } from '../lib/management-actions.ts';
import { planFollowups } from '../lib/agent-followups.ts';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

const SCHEMA = `PRAGMA foreign_keys=ON;
  CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
  CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
  CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
  CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
  INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);`;

// 10:00 Amman, inside the work-hours window the stale-approval nudge sits in.
const AT = Date.UTC(2026, 8, 16, 7, 0);
const THREE_DAYS_AGO = AT - 3 * 24 * 60 * 60_000;

function seed(db, approvals) {
  migrateManagementActions(db);
  for (const [id, summary] of approvals) {
    db.prepare(`INSERT INTO approvals (id,type,status,requested_by,requested_by_name,entity_type,entity_id,summary,payload,created_at)
      VALUES(?,'task_create','pending','member','خالد','task',NULL,?,'{}',?)`).run(id, summary, THREE_DAYS_AGO);
  }
}

function followupFixture(t, approvals) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(SCHEMA);
  seed(db, approvals);
  const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'member', number: '962770000000' }], groupId: '123@g.us' };
  return planFollowups(db, config, AT).find(plan => plan.kind === 'stale_approval');
}

test('one pending request gets its own approve/reject poll, not "اكتب اعتمد 1"', t => {
  const plan = followupFixture(t, [['a1', 'فتح مهمة زيارة النقابة']]);
  assert.ok(plan, 'the nudge must still be planned');
  assert.ok(plan.choices, 'this message was the last one still asking him to type');
  assert.equal(plan.choices.id, 'APRa1');
  assert.deepEqual(plan.choices.options.map(o => o.id), ['APRa1Y', 'APRa1N']);
  // The typed instructions stay in the text: a poll can be missed or dismissed.
  assert.match(plan.text, /اعتمد/);
});

test('several pending requests get a picker whose options are the requests', t => {
  const plan = followupFixture(t, [['a1', 'فتح مهمة زيارة النقابة'], ['a2', 'تحويل عقد الإيجار']]);
  assert.equal(plan.choices.id, 'APKQ');
  assert.deepEqual(plan.choices.options.map(o => o.id), ['APKa1', 'APKa2']);
  assert.deepEqual(plan.choices.options.map(o => o.label), ['1. فتح مهمة زيارة النقابة', '2. تحويل عقد الإيجار']);
});

test('the picker is capped at ten and its labels stay unique when two requests read alike', t => {
  const same = Array.from({ length: 12 }, (_, i) => [`a${i}`, 'نفس الملخص']);
  const plan = followupFixture(t, same);
  assert.equal(plan.choices.options.length, 10);
  assert.equal(new Set(plan.choices.options.map(o => o.label)).size, 10, 'a vote is matched by hashing the label -- duplicates would sink the poll');
});

function tapFixture(t, approvals) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(SCHEMA);
  seed(db, approvals);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'member', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0, asked = 0; const now = AT;
  const run = (extra = {}) => handleSecretaryEvent(db, {
    messageId: `E-${++count}`, senderNumber: '12025550103', groupId: null, text: 'x', receivedAt: now, responseMessageId: `R-${count}`, ...extra,
  }, config, { infer: async () => { asked += 1; return emptySecretaryIntent('chat', 'تمام'); }, now: () => now });
  return { db, run, modelCalls: () => asked };
}
const tap = (questionId, optionId) => ({ choice: { questionId, optionId } });

test('tapping a request in the picker answers with that request and its own decision poll', async t => {
  const f = tapFixture(t, [['a1', 'فتح مهمة زيارة النقابة'], ['a2', 'تحويل عقد الإيجار']]);
  const r = await f.run(tap('APKQ', 'APKa2'));
  assert.equal(f.modelCalls(), 0, 'a tap must resolve in code');
  assert.match(r.reply, /تحويل عقد الإيجار/);
  assert.equal(r.choices.id, 'APRa2');
  assert.deepEqual(r.choices.options.map(o => o.id), ['APRa2Y', 'APRa2N']);
});

test('a request decided since the picker was sent says so instead of re-offering it', async t => {
  const f = tapFixture(t, [['a1', 'فتح مهمة زيارة النقابة'], ['a2', 'تحويل عقد الإيجار']]);
  f.db.prepare("UPDATE approvals SET status='approved' WHERE id='a2'").run();
  const r = await f.run(tap('APKQ', 'APKa2'));
  assert.equal(r.status, 'clarify');
  assert.match(r.reply, /ما عاد معلّق/);
  assert.equal(f.modelCalls(), 0);
});

test('an employee tapping the picker never decides anything -- approvals are Basim-only', async t => {
  const f = tapFixture(t, [['a1', 'فتح مهمة زيارة النقابة'], ['a2', 'تحويل عقد الإيجار']]);
  const r = await f.run({ senderNumber: '12025550101', ...tap('APKQ', 'APKa2') });
  assert.notEqual(r.choices?.id, 'APRa2');
});
