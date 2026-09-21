// Basim, 2026-09-20, reporting for خالد: "ليش خالد ما عنده نظام الارقام
// فعال ممكن تتاكد انه موجود للكل؟". It was active -- that was the problem.
// The assistant printed six numbered tasks and asked which one he wanted to
// finish; he answered "2", and the number was resolved against a DIFFERENT
// list (every task of his, in the standard order) and read as "assign that
// one to me", so he got "المهمة معيّنة لك؛ قل «استلم المهمة»" back, twice,
// and nothing closed. A number typed under a question answers THAT question,
// from THAT list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';
import { CHOICE_CANCEL } from '../lib/secretary-choices.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: 'ab'.repeat(32), contacts: [{ userId: 'basem', number: '12025550103' }, { userId: 'khaled', number: '12025550101' }], allowedGroupIds: ['12345@g.us'] };
  let count = 0; const now = 1788580000000;
  const say = (text, infer, sender = '12025550101') => handleSecretaryEvent(db,
    { messageId: `E-${++count}`, senderNumber: sender, groupId: null, text, receivedAt: now, responseMessageId: `R-${count}` },
    config, { infer: infer || (async () => { assert.fail('this turn must resolve in code, not by asking the model'); }), now: () => now });
  const tap = (questionId, optionId, sender = '12025550101') => handleSecretaryEvent(db,
    { messageId: `E-${++count}`, senderNumber: sender, groupId: null, text: '', receivedAt: now, responseMessageId: `R-${count}`, choice: { questionId, optionId } },
    config, { infer: async () => { assert.fail('a tap resolves in code'); }, now: () => now });
  return { db, say, tap };
}
const status = (db, id) => db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;
const rows = db => db.prepare('SELECT COUNT(*) AS n FROM secretary_task_choice').get().n;

// The picker arrives by typing the close command with two tasks in progress.
async function askWhichOne(f) {
  const asked = await f.say('انهاء المهمة');
  assert.equal(asked.status, 'clarify');
  assert.ok(asked.choices, 'a numbered picker is offered');
  assert.equal(rows(f.db), 1, 'and it is recorded as the live question');
  return asked;
}

// Basim, 2026-09-21, after Shadi typed "5" into a chat that already had the
// task menu waiting and closed a task he was still working on: "الغي كل
// الاحتمالات وضلك كررله يختار خيار فقط لحد ما يختار من القائمة". A typed number no
// longer answers an employee's open question -- nothing typed does. The
// question comes back, with its way out on it, until he taps.
test('an employee cannot answer an open question by typing -- not a number, not anything', async t => {
  const f = fixture(t);
  const asked = await askWhichOne(f);
  for (const typed of ['2', '7', 'خلصت', 'شو مبيعات اليوم']) {
    const reply = await f.say(typed);
    assert.match(reply.reply, /اختار من القائمة/, `"${typed}" must be refused, not acted on`);
    assert.ok(reply.choices, 'and the same question comes back rather than being pointed at');
    assert.ok(reply.choices.options.some(o => o.label === CHOICE_CANCEL), 'carrying the way out');
  }
  assert.equal(rows(f.db), 1, 'the question is still standing');
  assert.equal(status(f.db, A), 'progress');
  assert.equal(status(f.db, B), 'progress');
  // ...and the tap he was supposed to make still works.
  const done = await f.tap(asked.choices.id, asked.choices.options[1].id);
  assert.doesNotMatch(done.reply, /اختار من القائمة/);
  assert.equal(rows(f.db), 0, 'answered and gone');
});

// The way out is universal: it is appended to every poll that does not carry
// one of its own, and answering it leaves nothing behind waiting on him.
test('choosing the way out drops the question and frees him to type again', async t => {
  const f = fixture(t);
  const asked = await askWhichOne(f);
  const out = asked.choices.options.find(o => o.label === CHOICE_CANCEL);
  assert.ok(out, 'every poll carries it');
  const cancelled = await f.tap(asked.choices.id, out.id);
  assert.match(cancelled.reply, /ألغيت الطلب/);
  assert.equal(rows(f.db), 0, 'nothing left waiting');
  assert.equal(status(f.db, A), 'progress');
  const after = await f.say('شو أخبارك', async () => emptySecretaryIntent('clarify', 'تمام'));
  assert.doesNotMatch(after.reply, /اختار من القائمة/, 'and he can talk again');
});

// Basim runs the place from this chat and types into it all day; an approval
// poll sitting in his thread must never stop him. The lock is the employees'.
test('Basim is not locked by an open poll -- his typed number still answers it', async t => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
    ('b1','ترخيص دابوق','','red','progress','باسم','باسم',1,3,3),
    ('b2','عقد النفايات','','red','progress','باسم','باسم',1,4,4)`);
  const asked = await f.say('انهاء المهمة', undefined, '12025550103');
  assert.ok(asked.choices);
  const second = asked.choices.options[1].label.replace(/^\d+\.\s*/, '');
  const reply = await f.say('2', undefined, '12025550103');
  assert.doesNotMatch(reply.reply, /اختار من القائمة/, 'he is never told to stop typing');
  assert.match(reply.reply, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)));
  assert.equal(rows(f.db), 0);
});

test('with no picker waiting, a number keeps its old meaning', async t => {
  const f = fixture(t);
  assert.equal(rows(f.db), 0);
  // No live question: the bare ordinal picker answers, as it always has --
  // both of these tasks are already his, so it says exactly that.
  const reply = await f.say('1', async () => emptySecretaryIntent('clarify', 'أي مهمة؟'));
  assert.doesNotMatch(reply.reply, /الرقم مش من القائمة/);
});

test('the picker also wins over Basim\'s five-command menu', async t => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
    ('c1','ترخيص دابوق','','red','progress','باسم','باسم',1,3,3),
    ('c2','عقد النفايات','','red','progress','باسم','باسم',1,4,4)`);
  const asked = await f.say('انهاء المهمة', undefined, '12025550103');
  assert.ok(asked.choices, 'Basim gets the same picker');
  // "2" would otherwise be rewritten to the menu's second command (a note).
  const reply = await f.say('2', undefined, '12025550103');
  assert.doesNotMatch(reply.reply, /شو الملاحظة|أضيف ملاحظة/, 'the menu must not hijack the answer');
  assert.equal(rows(f.db), 0);
});

// Basim, 2026-09-20: "بدي خالد يكتب 1 تطلعلو الخيارات مثلي". A digit means
// one thing now, for everyone: the question above it when one is waiting,
// the five-command menu when none is.
test('an employee typing 1 with nothing pending gets the same menu Basim gets', async t => {
  const f = fixture(t);
  const forKhaled = await f.say('1');
  const forBasim = await f.say('1', undefined, '12025550103');
  assert.match(forKhaled.reply, /الشغل المطلوب/, 'خالد: digit 1 opens a new task');
  assert.equal(forKhaled.reply, forBasim.reply, 'the same answer for both, word for word');
});

test('5 finishes, for an employee, without the model and without an ownership request', async t => {
  const f = fixture(t);
  const asked = await f.say('5');
  assert.match(asked.reply, /إنهاء مهمة/, 'the digit reaches the finish command, not the ordinal picker');
  assert.doesNotMatch(asked.reply, /معيّنة لك/);
  assert.equal(rows(f.db), 1, 'and it leaves the picker waiting for his number');
});

// Basim, 2026-09-20: Khalid asked to finish a task, and the question came
// back as plain text with nothing to tap -- while the same question gave
// Basim a real poll. Two of Khalid's tasks were named exactly the same
// ("برمجة كاميرات دابوق", the duplicate), and the bridge refuses a poll whose
// labels are not unique: a vote is matched by hashing the label, so it
// dropped the whole poll on the way out. The number in front makes every
// label unique whatever the titles are.
test('two tasks with the identical title still produce a valid, tappable poll', async t => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
    ('d1','برمجة كاميرات دابوق','','red','progress','خالد','خالد',1,3,3),
    ('d2','برمجة كاميرات دابوق','','red','progress','خالد','خالد',1,4,4)`);
  const asked = await f.say('انهاء المهمة');
  const labels = asked.choices.options.map(o => o.label);
  assert.equal(new Set(labels).size, labels.length, 'every label unique, or WhatsApp drops the poll');
  assert.equal(labels.filter(l => l.endsWith('برمجة كاميرات دابوق')).length, 2, 'both duplicates are still offered');
  // And the numbers in the poll match the numbers in the text above it.
  labels.slice(0, -1).forEach((label, index) => {
    assert.ok(label.startsWith(`${index + 1}. `), label);
    assert.match(asked.reply, new RegExp(`${index + 1}\\. `));
  });
});

// The lock is not only for a poll he asked for: a poll the secretary sends him
// on its own -- a nudge, a task card, an approval -- puts him in the same
// place, and the way out is on that one too.
test('a poll pushed to him unprompted locks his typing exactly the same way', async t => {
  const f = fixture(t);
  const { enqueueAgentMessage } = await import('../lib/agent-followups.ts');
  enqueueAgentMessage(f.db, { toUser: 'khaled', text: 'شو بدك تعمل؟',
    choices: { id: 'XQ', title: 'شو بدك تعمل؟', expiresAt: 1788580000000 + 3600_000, options: [{ id: 'X1', label: 'واحد' }, { id: 'X2', label: 'اثنين' }] } }, 1788580000000);
  const sent = JSON.parse(f.db.prepare("SELECT choices_json AS c FROM agent_outbox WHERE to_user='khaled'").get().c);
  assert.equal(sent.options.at(-1).label, CHOICE_CANCEL, 'the way out is added on the way out the door');
  const refused = await f.say('تمام');
  assert.match(refused.reply, /اختار من القائمة/);
  const freed = await f.tap('XQ', sent.options.at(-1).id);
  assert.match(freed.reply, /ألغيت الطلب/);
  const after = await f.say('شو أخبارك', async () => emptySecretaryIntent('clarify', 'تمام'));
  assert.doesNotMatch(after.reply, /اختار من القائمة/);
});

// Basim, asked how long the lock should hold: "ماشي 24 ساعه كويس". The picker
// used to live ten minutes, which was fine while it only asked a question --
// but now it also holds him, and a ten-minute unlock would have handed his
// next stray digit straight back to the command that closed Shadi's task.
test('the question that holds him lives a full day, not ten minutes', async t => {
  const f = fixture(t);
  const asked = await askWhichOne(f);
  assert.equal(asked.choices.expiresAt - 1788580000000, 24 * 60 * 60_000);
  assert.equal(f.db.prepare('SELECT expires_at AS e FROM secretary_task_choice').get().e - 1788580000000, 24 * 60 * 60_000,
    'the poll and the row it answers must die together, or a tap lands on nothing');
});
