import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleSecretaryEvent, migrateSecretary } from "../lib/secretary-service.ts";
import { emptySecretaryIntent } from "../lib/secretary-intent.ts";
import { listApprovals, requestDeadlineExtension, requestTaskOwnership } from "../lib/approvals.ts";

// Basim's complaint, verbatim: his approvals arrive green/red with nothing to
// tap, and once more than one request is pending the bot "شبكهم في بعض" --
// he can't tell which number is which. These tests exercise the real,
// end-to-end WhatsApp path (handleSecretaryEvent, not just the agent helper):
// a tap on a specific request's ✅/❌ button must resolve exactly that
// request regardless of how many others are pending, a stale/replayed tap
// must fail cleanly without applying anything, and the pre-existing
// text-based "اعتمد رقم/الكل" flows must keep working unchanged.

function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO tasks VALUES('t','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled: true, sharedKey: "ab".repeat(32), contacts: [{ userId: "basem", number: "12025550103" }, { userId: "member", number: "12025550101" }, { userId: "other", number: "12025550102" }], allowedGroupIds: ["12345@g.us"] };
  let count = 0, now = 1788580000000;
  const event = (extra = {}) => ({ messageId: `EVENT-${++count}`, senderNumber: "12025550101", groupId: null, text: "شو مهامي؟", receivedAt: now, responseMessageId: `REPLY-${count}`, ...extra });
  const run = (plan = emptySecretaryIntent("summary"), extra = {}, infer) => handleSecretaryEvent(db, event(extra), config, { infer: infer || (async () => plan), now: () => now });
  return { db, config, event, run, get now() { return now; }, tick: n => { now += n; } };
}
const owner = { id: "basem", name: "باسم", role: "admin", active: 1 };
const khaled = { id: "member", name: "خالد", role: "member", active: 1 };
const shadi = { id: "other", name: "شادي", role: "member", active: 1 };
const asOwner = { senderNumber: "12025550103" };
const pendingList = db => listApprovals(db, owner, { status: "pending" });

test("tap-to-decide: a poll button resolves only the tapped approval, a stale/replayed tap fails cleanly, and text-based اعتمد/ارفض still works", async t => {
  const f = fixture(t);
  requestDeadlineExtension(f.db, khaled, { taskId: "t", newDueDate: "2026-09-20", reason: "سبب" }, { now: f.now });
  requestTaskOwnership(f.db, shadi, { taskId: "t" }, { now: f.now + 1 });
  assert.equal(pendingList(f.db).length, 2);

  const list = await f.run(emptySecretaryIntent("approvals"), { ...asOwner, text: "شو الطلبات المعلقة؟" });
  assert.ok(list.choices, "owner listing must attach a real tap-to-decide poll");
  assert.equal(list.choices.options.length, 4, "one ✅/❌ pair per pending request");

  // Tap the extension request's approve button -- must resolve THAT request
  // only, leaving شادي's ownership request untouched, no ordinal typing needed.
  const approveExtension = list.choices.options.find(o => /تمديد/.test(o.label) && o.label.includes("✅"));
  assert.ok(approveExtension, `expected an approve option for the extension among: ${list.choices.options.map(o => o.label).join(" | ")}`);
  const tapped = await f.run(undefined, { ...asOwner, choice: { questionId: list.choices.id, optionId: approveExtension.id } });
  assert.equal(tapped.status, "applied");
  assert.match(tapped.reply, /تمديد/);
  assert.equal(f.db.prepare("SELECT due_date FROM tasks WHERE id='t'").get().due_date, "2026-09-20");
  const afterTap = pendingList(f.db);
  assert.equal(afterTap.length, 1, "only the tapped approval was decided");
  assert.equal(afterTap[0].type, "task_ownership");

  // Re-tapping the same (now-consumed) poll must error cleanly, not crash or
  // silently no-op as if it worked, and must never re-apply anything.
  const replay = await f.run(undefined, { ...asOwner, choice: { questionId: list.choices.id, optionId: approveExtension.id } });
  assert.equal(replay.status, "clarify");
  assert.match(replay.reply, /غير مرتبط|انتهت صلاحيته/);
  assert.equal(pendingList(f.db).length, 1);

  // A fresh poll for the one remaining request; tap reject this time.
  const second = await f.run(emptySecretaryIntent("approvals"), { ...asOwner, text: "الطلبات؟" });
  assert.equal(second.choices.options.length, 2);
  const rejectOwnership = second.choices.options.find(o => o.label.includes("❌"));
  const rejected = await f.run(undefined, { ...asOwner, choice: { questionId: second.choices.id, optionId: rejectOwnership.id } });
  assert.equal(rejected.status, "applied");
  assert.equal(pendingList(f.db).length, 0);
  assert.equal(f.db.prepare("SELECT status FROM approvals WHERE type='task_ownership'").get().status, "rejected");

  // An expired poll (>30 min old) must not apply the decision when tapped.
  requestDeadlineExtension(f.db, khaled, { taskId: "t", newDueDate: "2026-09-25", reason: "ثاني" }, { now: f.now });
  const third = await f.run(emptySecretaryIntent("approvals"), { ...asOwner, text: "الطلبات؟" });
  assert.ok(third.choices);
  f.tick(31 * 60_000);
  const approveThird = third.choices.options.find(o => o.label.includes("✅"));
  const stale = await f.run(undefined, { ...asOwner, choice: { questionId: third.choices.id, optionId: approveThird.id } });
  assert.equal(stale.status, "clarify");
  assert.equal(pendingList(f.db).length, 1, "an expired tap must not have decided anything");
  assert.equal(f.db.prepare("SELECT due_date FROM tasks WHERE id='t'").get().due_date, "2026-09-20", "unchanged by the expired tap");

  // The pre-existing text-based "اعتمد الكل" flow must still work exactly as before.
  const all = await f.run({ ...emptySecretaryIntent("decide", "اعتمد الكل"), action: "approve" }, { ...asOwner, text: "اعتمد الكل" });
  assert.equal(all.status, "applied");
  assert.equal(pendingList(f.db).length, 0);
  assert.equal(f.db.prepare("SELECT due_date FROM tasks WHERE id='t'").get().due_date, "2026-09-25");
});

test("a group-chat reply and an employee's own request view never get a live poll, only the private owner conversation does", async t => {
  const f = fixture(t);
  requestDeadlineExtension(f.db, khaled, { taskId: "t", newDueDate: "2026-09-20", reason: "سبب" }, { now: f.now });
  // Basim addressing the secretary from the team group: still text-only, since
  // a tapped button there could never reach only him.
  const fromGroup = await f.run(emptySecretaryIntent("approvals"), { ...asOwner, groupId: "12345@g.us", text: "يا سكرتير شو الطلبات المعلقة؟" });
  assert.equal(fromGroup.choices, undefined);
  // خالد asking about his own filed request gets the existing plain list, never a decision poll (he can't decide anything).
  const employee = await f.run(emptySecretaryIntent("approvals"), { text: "شو صار بطلبي؟" });
  assert.equal(employee.choices, undefined);
  assert.match(employee.reply, /بانتظار قرار باسم/);
});
