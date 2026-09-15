// Basim (2026-09-15): "بس يطلب تمديد اعطيه خيارات يوم - يومين - 5 ايام فقط
// وخليها تيجيني موافقه وتنشر على الجروب قرار التمديد ... مشان نتجاوز مشكله
// الذكاء" -- the duration used to be a free-text answer ("اكتب عدد الأيام أو
// التاريخ الجديد") parsed by the model, which is where a vague reply became a
// guessed date. These cover the replacement end to end: the three fixed
// options are offered instead of the question, a tap computes the date in
// code from TODAY, and the result is an ordinary deadline_extension approval
// for Basim (which already carries its own decision poll and already posts
// the decision to the group -- see lib/approvals.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleSecretaryEvent, migrateSecretary } from "../lib/secretary-service.ts";
import { emptySecretaryIntent } from "../lib/secretary-intent.ts";
import { listApprovals, decideApproval } from "../lib/approvals.ts";

const NOW = 1788580000000; // 2026-09-05 in Amman (+3)
function fixture(t, { dueDate = "2026-01-01" } = {}) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('t','لوحة','تفاصيل','red','progress','خالد','خالد',1,${dueDate === null ? "NULL" : `'${dueDate}'`},NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: "ab".repeat(32), contacts: [{ userId: "basem", number: "12025550103" }, { userId: "member", number: "12025550101" }], allowedGroupIds: ["12345@g.us"] };
  let count = 0;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: "12025550101", groupId: null, text: "تمديد التاريخ", receivedAt: NOW, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (plan = emptySecretaryIntent("summary"), extra = {}, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => plan), now: () => NOW });
  return { db, run };
}
const tap = (questionId, optionId) => ({ choice: { questionId, optionId } });
const outbox = db => db.prepare("SELECT to_user AS toUser, text, choices_json AS choicesJson FROM agent_outbox ORDER BY id").all();
const owner = { id: "basem", name: "باسم", role: "admin", active: 1 };

test("tapping «تمديد التاريخ» offers the three fixed durations instead of asking for a date in words", async t => {
  const f = fixture(t);
  const asked = await f.run(undefined, tap("LGDQ", "LGDEXTEND"), async () => { throw Error("picking a duration must never reach the model"); });
  assert.equal(asked.status, "clarify");
  assert.doesNotMatch(asked.reply, /اكتب عدد الأيام|التاريخ الجديد/, "the free-text question is gone for employees");
  const options = asked.choices.options.map(option => option.label).join(" | ");
  assert.match(options, /يوم واحد/); assert.match(options, /يومين/); assert.match(options, /٥ أيام/);
  assert.equal(asked.choices.options.length, 3, "exactly three durations, no more");
});

test("a tapped duration counts from today, raises an approval for Basim, and never asks the model", async t => {
  const f = fixture(t);
  await f.run(undefined, tap("LGDQ", "LGDEXTEND"), async () => { throw Error("no model"); });
  const applied = await f.run(undefined, tap("EXTQt", "EXTtD2"), async () => { throw Error("a duration tap must resolve in code, never via the model"); });
  assert.equal(applied.status, "applied");
  // Today is 2026-09-05 in Amman; +2 counted from TODAY, not from the
  // task's own 2026-01-01 due date.
  assert.match(applied.reply, /2026-09-07/, "the new date is today + 2");
  const pending = listApprovals(f.db, owner, { status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, "deadline_extension");
  const toBasim = outbox(f.db).find(row => row.toUser === "basem" && /طلب تمديد/.test(row.text));
  assert.ok(toBasim, "Basim gets the request");
  assert.ok(toBasim.choicesJson, "with its approve/reject poll attached");
  // The task itself must not move until Basim decides.
  assert.equal(f.db.prepare("SELECT due_date AS dueDate FROM tasks WHERE id='t'").get().dueDate, "2026-01-01");
});

test("approving the request moves the date and posts the decision to the group", async t => {
  const f = fixture(t);
  await f.run(undefined, tap("LGDQ", "LGDEXTEND"), async () => { throw Error("no model"); });
  await f.run(undefined, tap("EXTQt", "EXTtD5"), async () => { throw Error("no model"); });
  const approval = listApprovals(f.db, owner, { status: "pending" })[0];
  const decision = decideApproval(f.db, owner, { approvalId: approval.id, decision: "approved" }, { now: NOW });
  assert.match(decision.notifyGroup, /مُدّد موعد مهمة «لوحة»/, "the group is told the decision");
  assert.match(decision.notifyGroup, /2026-09-10/);
  assert.equal(f.db.prepare("SELECT due_date AS dueDate FROM tasks WHERE id='t'").get().dueDate, "2026-09-10");
});

test("a task already due further out than the chosen duration is refused in plain words, with the poll offered again", async t => {
  const f = fixture(t, { dueDate: "2026-12-31" });
  await f.run(undefined, tap("LGDQ", "LGDEXTEND"), async () => { throw Error("no model"); });
  const refused = await f.run(undefined, tap("EXTQt", "EXTtD1"), async () => { throw Error("no model"); });
  assert.equal(refused.status, "clarify");
  assert.match(refused.reply, /أبعد من/, "explains why, rather than surfacing a raw validation error");
  assert.ok(refused.choices, "and lets them pick a longer duration without starting over");
  assert.equal(listApprovals(f.db, owner, { status: "pending" }).length, 0, "nothing was raised");
});

test("an unknown duration option is rejected outright", async t => {
  const f = fixture(t);
  await f.run(undefined, tap("LGDQ", "LGDEXTEND"), async () => { throw Error("no model"); });
  await f.run(emptySecretaryIntent("chat", "ok"), tap("EXTQt", "EXTtD90"), async () => emptySecretaryIntent("chat", "ok"));
  assert.equal(listApprovals(f.db, owner, { status: "pending" }).length, 0, "90 days is not one of the three offered durations");
  assert.equal(f.db.prepare("SELECT due_date AS dueDate FROM tasks WHERE id='t'").get().dueDate, "2026-01-01", "and nothing moved");
});

// Basim (2026-09-15): "حط التصويت الي كمان ياخي والموافقه كمان" -- he gets the
// same three durations. There is no approval to raise for him (he is the
// approver), so his tap becomes the ordinary pending confirmation his other
// sensitive actions already use -- which arrives with its own ✅/❌ poll, so he
// confirms with a tap rather than typing a token.
test("Basim gets the same three durations, and confirms his own extension with a tap", async t => {
  const f = fixture(t);
  // legendCandidates only ever offers the actor's OWN in-progress tasks, for
  // Basim exactly as for an employee, so give him one to extend.
  f.db.exec("UPDATE tasks SET owner='باسم',suggested_owner='باسم' WHERE id='t'");
  const asOwner = { senderNumber: "12025550103" };
  const asked = await f.run(undefined, { ...asOwner, ...tap("LGDQ", "LGDEXTEND") }, async () => { throw Error("the duration must never reach the model"); });
  assert.equal(asked.status, "clarify");
  assert.deepEqual(asked.choices.options.map(o => o.label), ["🟢 يوم واحد", "🟡 يومين", "🟠 ٥ أيام"]);

  const proposed = await f.run(undefined, { ...asOwner, ...tap("EXTQt", "EXTtD1") }, async () => { throw Error("no model"); });
  assert.equal(proposed.status, "confirmation", "his own extension is a confirmation, not a request to himself");
  assert.match(proposed.reply, /2026-09-06/);
  assert.equal(listApprovals(f.db, owner, { status: "pending" }).length, 0, "he never raises an approval with himself");
  assert.ok(proposed.choices, "and the confirmation carries its own tap poll");
  const confirmLabels = proposed.choices.options.map(o => o.label).join(" ");
  assert.match(confirmLabels, /موافق/); assert.match(confirmLabels, /إلغاء/);

  // Tapping موافق applies it directly -- no approval step in his own path.
  const token = f.db.prepare("SELECT token FROM secretary_pending").get().token;
  const done = await f.run(undefined, { ...asOwner, ...tap(`CFM${token}`, `CFM${token}Y`) }, async () => { throw Error("no model"); });
  assert.equal(done.status, "applied");
  assert.equal(f.db.prepare("SELECT due_date AS dueDate FROM tasks WHERE id='t'").get().dueDate, "2026-09-06");
});
