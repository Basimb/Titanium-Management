// Basim (2026-09-15), on the note/extension polls offering him only his own
// tasks: "شو يعني هاي؟" then "اظهر اول 10 بس انا مش معلق عليها بنفس اليوم مثلا".
// legendCandidates was written for an employee -- "a task is mine and I'm
// working on it" -- and applied to him unchanged, so with nothing claimed in
// his own name the bot told him "ما عندك مهمة قيد التنفيذ" while the team's
// tasks, all of them his to comment on, sat right there.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleSecretaryEvent, migrateSecretary } from "../lib/secretary-service.ts";
import { emptySecretaryIntent } from "../lib/secretary-intent.ts";

const NOW = Date.UTC(2026, 8, 15, 8, 0); // 2026-09-15, 11:00 Amman
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: "ab".repeat(32), contacts: [{ userId: "basem", number: "12025550103" }, { userId: "member", number: "12025550101" }, { userId: "other", number: "12025550102" }], allowedGroupIds: ["12345@g.us"] };
  let n = 0;
  // Named columns, never positional: migrateSecretary has already ALTERed
  // extra columns onto `tasks` by this point.
  const task = (id, title, owner, due = null, status = "progress") =>
    db.prepare("INSERT INTO tasks (id,title,details,priority,status,owner,suggested_owner,started_at,due_date,created_at,updated_at) VALUES(?,?,'','red',?,?,?,1,?,1,1)")
      .run(id, title, status, owner, owner, due);
  const say = (text, sender = "12025550103") => handleSecretaryEvent(db,
    { messageId: `E${++n}`, senderNumber: sender, groupId: null, text, receivedAt: NOW, responseMessageId: `R${n}` },
    config, { infer: async () => emptySecretaryIntent("clarify", "..."), now: () => NOW });
  return { db, task, say };
}
const CANCEL = "✖️ ولا إشي — ألغِ الطلب";
// Basim, 2026-09-19: every task picker now ends with a way out. These tests
// are about which TASKS are offered, so it is dropped here and asserted once,
// on its own, at the bottom of this file.
const labels = result => (result.choices?.options ?? []).map(option => option.label).filter(label => label !== CANCEL);

test("Basim's note poll offers the team's in-progress tasks, not only his own", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  f.task("b", "السجل التجاري", "شادي");
  const asked = await f.say("اضافة ملاحظة");
  assert.deepEqual(labels(asked), ["1. مزاولات الصيادلة", "2. السجل التجاري"]);
});

test("a task Basim already commented on TODAY drops out of his note poll, but not an older comment of his", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  f.task("b", "السجل التجاري", "شادي");
  f.task("c", "ترخيص دابوق", "خالد");
  f.db.prepare("INSERT INTO comments (task_id,author,body,created_at) VALUES(?,?,?,?)").run("b", "باسم", "تابعت مع المحامي", NOW - 3600_000);
  // His own comment from two days ago must NOT hide the task.
  f.db.prepare("INSERT INTO comments (task_id,author,body,created_at) VALUES(?,?,?,?)").run("c", "باسم", "قديم", NOW - 2 * 24 * 3600_000);
  // Someone ELSE commenting today is not Basim having had his say.
  f.db.prepare("INSERT INTO comments (task_id,author,body,created_at) VALUES(?,?,?,?)").run("a", "خالد", "حكيت مع النقابة", NOW - 3600_000);
  const asked = await f.say("اضافة ملاحظة");
  assert.deepEqual(labels(asked), ["1. مزاولات الصيادلة", "2. ترخيص دابوق"]);
});

test("the same-day rule is for notes only -- an extension still offers every in-progress task", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  f.task("b", "السجل التجاري", "شادي");
  f.db.prepare("INSERT INTO comments (task_id,author,body,created_at) VALUES(?,?,?,?)").run("b", "باسم", "تابعت", NOW - 3600_000);
  const asked = await f.say("تمديد التاريخ");
  assert.deepEqual(labels(asked), ["1. مزاولات الصيادلة", "2. السجل التجاري"]);
});

test("at most ten, overdue first -- a WhatsApp poll cannot show more", async t => {
  const f = fixture(t);
  for (let i = 1; i <= 14; i++) f.task(`t${i}`, `مهمة ${i}`, "خالد");
  f.task("late", "مهمة متأخرة", "شادي", "2026-09-01");
  const asked = await f.say("اضافة ملاحظة");
  const shown = labels(asked);
  assert.equal(shown.length, 10);
  assert.equal(shown[0], "1. مهمة متأخرة", "the overdue one leads");
});

test("closing and transferring keep the employee rule even for him", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  for (const text of ["انهاء المهمة", "تحويل المهمة"]) {
    const asked = await f.say(text);
    assert.equal(asked.choices, undefined, `${text}: no poll`);
    assert.match(asked.reply, /ما عندك مهمة/, `${text}: still scoped to his own tasks`);
  }
});

test("an employee is unaffected -- still only their own in-progress task", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  f.task("b", "السجل التجاري", "شادي");
  const asked = await f.say("اضافة ملاحظة", "12025550101");
  // Exactly one candidate resolves straight through, so no picker poll at all;
  // what matters is that شادي's task never became خالد's business.
  assert.doesNotMatch(asked.reply ?? "", /السجل التجاري/);
});

test("every task picker ends with a way out for a digit pressed by mistake", async t => {
  const f = fixture(t);
  f.task("a", "مزاولات الصيادلة", "خالد");
  f.task("b", "السجل التجاري", "شادي");
  const asked = await f.say("اضافة ملاحظة");
  const all = asked.choices.options.map(option => option.label);
  assert.equal(all.at(-1), CANCEL, "the way out is last, so no thumb lands on it by accident");
});
