// Basim's explicit ask before stepping away: "اعمل فحص لدوره كامله وحط
// عشوائي الخيارات وامتحن نفسك يدوي بكل الفكره" -- run a full-cycle check with
// randomized option values. This is that randomized regression pass: a
// seeded PRNG drives many random task/employee/action combinations through
// the real handleSecretaryEvent/planFollowups pipelines (never through the
// internal poll-building helpers directly, since none of those are
// exported -- going through the public entry points is also the more
// faithful "test the whole idea end to end" Basim asked for) and checks
// invariants that must hold no matter what values come up:
//   - a task-action poll always has 2-12 options (WhatsApp's own limits)
//     and every option id is in WhatsApp's allowed id charset
//   - a poll is only ever offered to the person actually responsible for
//     that task
//   - tapping any offered option, or an adversarially malformed one, never
//     throws and always resolves to a real status
//   - a reminder's date buckets account for every one of a person's open
//     tasks exactly once, in chronological order
//   - the workload leaderboard always names whoever truly has the most
//     open tasks, for any random distribution across the team
// The seed is fixed so a failure is always reproducible from the printed seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { planFollowups } from '../lib/agent-followups.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260907; // Basim's local date this feature bundle was requested.
const rand = mulberry32(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const EMPLOYEES = [{ id: 'e1', name: 'أيمن' }, { id: 'e2', name: 'خالد' }, { id: 'e3', name: 'شادي' }];
const OPTION_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

function buildDb(tasks) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('e1','أيمن','member',1,NULL,1,1),('e2','خالد','member',1,NULL,1,1),('e3','شادي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL);`);
  const insert = db.prepare("INSERT INTO tasks VALUES(?,'p',?,'',?,?,?,?,1,?,NULL,NULL,1,1,NULL,NULL)");
  for (const task of tasks) insert.run(task.id, task.title, task.priority, task.status, task.owner, task.suggestedOwner, task.dueDate);
  migrateSecretary(db);
  return db;
}
const CONFIG = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'e1', number: '12025550111' }, { userId: 'e2', number: '12025550112' }, { userId: 'e3', number: '12025550113' }], allowedGroupIds: ['12345@g.us'] };
const NUMBER_OF = { e1: '12025550111', e2: '12025550112', e3: '12025550113', basem: '12025550103' };
let seq = 0;
function makeEvent(extra) { return { messageId: `FZ-${++seq}`, responseMessageId: `FZR-${seq}`, groupId: null, text: 'شو مهامي؟', receivedAt: 1788580000000, ...extra }; }
function run(db, extra, infer) { return handleSecretaryEvent(db, makeEvent(extra), CONFIG, { infer: infer || (async () => emptySecretaryIntent('summary')), now: () => 1788580000000 }); }

test('randomized task-action polls: always 2-12 valid-charset options, always scoped to the responsible person', async t => {
  const ITERATIONS = 150;
  for (let i = 0; i < ITERATIONS; i++) {
    const status = pick(['open', 'progress', 'approval', 'completed']);
    const employee = pick(EMPLOYEES);
    const owner = status === 'open' ? null : employee.name;
    const suggestedOwner = status === 'open' ? pick([employee.name, null, pick(EMPLOYEES).name]) : employee.name;
    const id = uuid(i);
    const db = buildDb([{ id, title: `مهمة عشوائية ${i}`, priority: pick(['red', 'yellow', 'green']), status, owner, suggestedOwner, dueDate: pick([null, '2026-09-10', '2026-10-01']) }]);
    const viewer = pick(EMPLOYEES);
    const r = await run(db, { senderNumber: NUMBER_OF[viewer.id], text: 'تفاصيل مهمة', ...{} }, async () => ({ ...emptySecretaryIntent('details'), taskId: id }));
    if (!r.choices) continue; // no poll offered this round -- fine, not every combination qualifies
    assert.ok(r.choices.options.length >= 2 && r.choices.options.length <= 12, `seed ${SEED} iter ${i}: poll must have 2-12 options, got ${r.choices.options.length}`);
    for (const option of r.choices.options) assert.match(option.id, OPTION_ID_RE, `seed ${SEED} iter ${i}: option id "${option.id}" must be in WhatsApp's allowed charset`);
    assert.match(r.choices.id, OPTION_ID_RE, `seed ${SEED} iter ${i}: question id must be in WhatsApp's allowed charset`);
    const responsible = owner || suggestedOwner;
    assert.equal(responsible, viewer.name, `seed ${SEED} iter ${i}: a poll was offered to ${viewer.name} for a task actually responsible to ${responsible}`);
    db.close();
  }
});

test('randomized poll taps (valid and adversarially malformed) never throw and always resolve to a real status', async t => {
  const ITERATIONS = 150;
  const ACTIONS = ['CLAIM', 'FINISH', 'NOTE', 'TRANSFER', 'EDIT', 'EXTEND', 'GARBAGE', '', 'CLAIMX'];
  for (let i = 0; i < ITERATIONS; i++) {
    const status = pick(['open', 'progress', 'approval', 'completed']);
    const employee = pick(EMPLOYEES);
    const owner = status === 'open' ? null : employee.name;
    const suggestedOwner = status === 'open' ? employee.name : employee.name;
    const id = pick([uuid(i), 'not-a-real-uuid', uuid(i).toUpperCase(), '']);
    const db = buildDb(id && id.startsWith('0') ? [{ id, title: `مهمة ${i}`, priority: 'yellow', status, owner, suggestedOwner, dueDate: null }] : []);
    const viewer = pick(EMPLOYEES);
    const action = pick(ACTIONS);
    const questionId = pick([`TSKQ${id}`, `TSKQ${id}`, 'TSKQ', 'garbage']);
    const optionId = pick([`TSK${id}${action}`, 'garbage', '']);
    // CLAIM/FINISH resolve deterministically and must never reach the model;
    // NOTE/TRANSFER/EXTEND are deliberately rewritten and handed to it (see
    // resolveTaskActionTextChoice), so the stub here answers instead of
    // throwing -- this test's only claim is "never throws", not "never infers".
    let threw = null; let result;
    try { result = await run(db, { senderNumber: NUMBER_OF[viewer.id], choice: { questionId, optionId } }, async () => emptySecretaryIntent('clarify', 'وضح أكثر')); }
    catch (error) { threw = error; }
    assert.equal(threw, null, `seed ${SEED} iter ${i}: tap (q=${questionId}, o=${optionId}) must never throw a real error -- ${threw?.message}`);
    assert.equal(typeof result.status, 'string', `seed ${SEED} iter ${i}: must always resolve to a status`);
    db.close();
  }
});

test('randomized reminder buckets account for every open task exactly once, in chronological order', () => {
  const ITERATIONS = 80;
  for (let i = 0; i < ITERATIONS; i++) {
    const dayOffsets = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick([null, -5, 0, 1, 2, 5, 20]));
    const today = new Date(Date.UTC(2026, 8, 10));
    const tasks = dayOffsets.map((offset, index) => ({
      id: uuid(i * 100 + index), title: `م${index}`, priority: 'yellow', status: 'progress', owner: 'خالد', suggestedOwner: 'خالد',
      dueDate: offset === null ? null : new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10),
    }));
    const db = buildDb(tasks);
    const config = { enabled: true, contacts: [{ userId: 'basem', number: '966500000000' }, { userId: 'e2', number: '962770000000' }], groupId: null };
    const plans = planFollowups(db, config, Date.UTC(2026, 8, 10, 5, 0)).filter(p => p.kind === 'auto_reminder_morning' && p.targetUser === 'e2');
    if (plans.length) {
      const text = plans[0].text;
      const numberedLines = text.match(/^\d+\. /gm) || [];
      assert.equal(numberedLines.length, tasks.length, `seed ${SEED} iter ${i}: every task must appear exactly once across all buckets`);
      const headings = ['🔴 متأخرة', 'اليوم', 'بكرة', 'بعد بكرة', 'خلال أسبوع', 'لاحقًا', 'بدون موعد محدد'].map(h => text.indexOf(`*${h}*`)).filter(pos => pos >= 0);
      assert.deepEqual(headings, [...headings].sort((a, b) => a - b), `seed ${SEED} iter ${i}: bucket headings must stay in chronological order`);
    }
    db.close();
  }
});

test('the workload leaderboard always names whoever truly has the most open tasks, for any random distribution', async () => {
  const ITERATIONS = 80;
  for (let i = 0; i < ITERATIONS; i++) {
    const counts = { 'أيمن': 0, 'خالد': 0, 'شادي': 0 };
    const taskCount = Math.floor(rand() * 12);
    const tasks = [];
    for (let n = 0; n < taskCount; n++) {
      const name = pick(EMPLOYEES).name;
      const status = pick(['open', 'progress', 'completed']);
      if (status !== 'completed') counts[name]++;
      tasks.push({ id: uuid(i * 100 + n), title: `م${n}`, priority: 'yellow', status, owner: status === 'open' ? null : name, suggestedOwner: name, dueDate: null });
    }
    const db = buildDb(tasks);
    const r = await run(db, { senderNumber: NUMBER_OF.basem, text: 'مين أكثر موظف عنده مهام؟' }, async () => { throw Error('recognized workload question must never reach the model'); });
    const max = Math.max(...Object.values(counts));
    if (max === 0) { assert.match(r.reply, /ما في مهام مفتوحة موزّعة/, `seed ${SEED} iter ${i}`); }
    else {
      const leaders = Object.entries(counts).filter(([, c]) => c === max).map(([name]) => name);
      assert.ok(leaders.some(name => r.reply.includes(name)), `seed ${SEED} iter ${i}: reply must name a true leader (${leaders.join('/')}) with ${max} tasks -- got: ${r.reply}`);
    }
    db.close();
  }
});
