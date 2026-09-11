import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canViewManagementTask, executeManagementAction, getManagementSnapshot, isManagementAdmin,
  ManagementActionError, migrateManagementActions, parseManagementCommand,
} from "../lib/management-actions.ts";

const admin = { id: "basem", name: "مدير تجريبي", role: "admin", active: 1 };
const member = { id: "member", name: "موظف تجريبي", role: "member", active: 1 };
const other = { id: "other", name: "موظف آخر", role: "member", active: 1 };
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL,
      pin_salt TEXT,pin_hash TEXT,created_at INTEGER DEFAULT 1,updated_at INTEGER DEFAULT 1);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'yellow',status TEXT NOT NULL,owner TEXT,
      suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),author TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT NOT NULL,action TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO users (id,name,role,active,pin_hash) VALUES ('basem','مدير تجريبي','admin',1,'private-hash'),('member','موظف تجريبي','member',1,NULL),('other','موظف آخر','member',1,NULL),('fake-admin','إدارة أخرى','admin',1,NULL);
    INSERT INTO tasks (id,title,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
      ('own','إنجاز تجريبي','progress','موظف تجريبي','موظف تجريبي',110,100,110),
      ('assigned','مقترحة للموظف','open',NULL,'موظف تجريبي',NULL,100,100),
      ('private','سرّي للموظف الآخر','progress','موظف آخر','موظف آخر',110,100,110),
      ('unassigned','غير معيّنة','open',NULL,NULL,NULL,100,100),
      ('blocked','مهمة إضافية للموظف','progress','موظف تجريبي','موظف تجريبي',110,100,110);
    INSERT INTO comments (task_id,author,body,created_at) VALUES ('private','موظف آخر','تفاصيل خاصة',120);
    INSERT INTO attachments VALUES ('file-private','private','private.pdf','application/pdf',5,'private-object-key','موظف آخر',120);`);
  return db;
}
const run = (db, command, actor = admin, options = {}) => executeManagementAction(db, actor, command, { now: 200, ...options });
const row = (db, id = "own") => db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const denied = (fn, code, status) => assert.throws(fn, error => error instanceof ManagementActionError && error.code === code && (!status || error.status === status));
const plain = value => JSON.parse(JSON.stringify(value));

test("additive migration is repeatable and the snapshot carries flat tasks with no grouping entity", t => {
  const db = fixture(t);
  migrateManagementActions(db); migrateManagementActions(db);
  const snapshot = getManagementSnapshot(db, admin);
  assert.equal(snapshot.tasks.find(task => task.id === "own").updatedAt, 110);
  assert.equal(snapshot.tasks.find(task => task.id === "own").archivedAt, null);
  assert.equal(count(db, "tasks"), 5);
  // Projects were removed from the product: neither the snapshot shape nor the
  // task rows carry any grouping entity anymore.
  assert.equal(snapshot.projects, undefined);
  assert.ok(!Object.keys(snapshot.tasks[0]).some(key => /project/i.test(key)));
  assert.ok(!db.prepare("PRAGMA table_info(tasks)").all().some(column => column.name === "project_id"));
  assert.ok(!JSON.stringify(snapshot).includes("private-hash"));
});

test("migration backfills archived_at/archived_by on tasks completed before auto-archive-on-approve shipped, once, and leaves everything else alone", t => {
  const db = fixture(t);
  // "أدابتر كهرباء لتليفون أفايا": finished under the old code, before the
  // approve action started stamping archived_at/archived_by itself -- stuck
  // status='completed' with archived_at NULL forever with no code path ever
  // revisiting it, exactly what Basim found via "شو مهامي؟".
  db.exec("INSERT INTO tasks (id,title,status,owner,completed_at,created_at,updated_at) VALUES ('legacy-done','أدابتر كهرباء لتليفون أفايا','completed','باسم',150,100,150)");
  // A task completed with no completed_at at all (older still) must still get
  // a real timestamp, not NULL.
  db.exec("INSERT INTO tasks (id,title,status,owner,created_at,updated_at) VALUES ('legacy-done-no-completed-at','مهمة قديمة بلا تاريخ إنجاز','completed','باسم',100,120)");
  // A task the new code already archived on approval must be left exactly as is.
  db.exec("INSERT INTO tasks (id,title,status,owner,completed_at,created_at,updated_at,archived_at,archived_by) VALUES ('already-archived','مهمة أرشفت حديثًا','completed','باسم',150,100,150,151,'باسم')");
  migrateManagementActions(db);
  assert.equal(row(db, "legacy-done").archived_at, 150);
  assert.equal(row(db, "legacy-done").archived_by, "باسم");
  assert.equal(row(db, "legacy-done-no-completed-at").archived_at, 120);
  assert.equal(row(db, "legacy-done-no-completed-at").archived_by, "باسم");
  // A task the new code already archived on approval must be left exactly as is.
  assert.equal(row(db, "already-archived").archived_at, 151);
  // A still-open/in-progress task is never touched by this backfill.
  assert.equal(row(db, "own").archived_at, null);
  // Re-running (every request does) must be a no-op: nothing left to backfill.
  const before = row(db, "legacy-done");
  migrateManagementActions(db);
  assert.deepEqual(row(db, "legacy-done"), before);
});

// Neither the action engine nor its command parser knows any project action
// anymore, so a stale client (or a replayed old WhatsApp confirmation) asking
// for one is rejected outright rather than half-applied.
test("every removed project action is an unknown action, not a half-supported one", t => {
  const db = fixture(t);
  for (const command of [
    { action: "add_project", name: "مشروع" }, { action: "edit_project", projectId: "p", name: "تعديل" },
    { action: "approve_project", projectId: "p" }, { action: "reject_project", projectId: "p", reason: "سبب" },
    { action: "restore_project", projectId: "p" }, { action: "archive_project", projectId: "p" },
    { action: "delete_project", projectId: "p" }, { action: "move_task", taskId: "own", projectId: "q" },
  ]) {
    denied(() => parseManagementCommand(command), "unknown_action", 400);
    denied(() => run(db, command), "unknown_action", 400);
  }
  // add_task/edit_task no longer accept a projectId field at all.
  denied(() => parseManagementCommand({ action: "add_task", title: "مهمة", projectId: "p" }), "invalid_fields", 400);
  denied(() => parseManagementCommand({ action: "edit_task", taskId: "own", projectId: "p" }), "invalid_fields", 400);
  // ...and neither does the stale-version guard.
  for (const expected of ["expectedProjectId", "expectedProjectUpdatedAt", "expectedProjectStatus", "expectedTargetProjectUpdatedAt"]) {
    denied(() => parseManagementCommand({ action: "submit", taskId: "own", [expected]: "p" }), "invalid_fields", 400);
  }
  assert.equal(count(db, "audit_logs"), 0);
});

test("member snapshot scopes tasks, files, comments, users and audit metadata", t => {
  const db = fixture(t);
  run(db, { action: "comment", taskId: "own", comment: "تحديث ظاهر" }, member, {
    source: "whatsapp_secretary", auditContext: { originalText: "نص كامل", senderNumber: "+12025550101", sourceMessageId: "message-1" },
  });
  const snapshot = getManagementSnapshot(db, member);
  assert.deepEqual(snapshot.tasks.map(x => x.id).sort(), ["assigned", "blocked", "own"]);
  // A member sees every active colleague (needed to name one in a transfer,
  // message, or correction), not just themselves -- task/comment/
  // attachment/activity detail stays scoped, asserted separately below.
  assert.deepEqual(snapshot.users.map(x => x.id).sort(), ["basem", "fake-admin", "member", "other"]);
  assert.equal(snapshot.attachments.length, 0);
  assert.deepEqual(snapshot.comments.map(x => x.body), ["تحديث ظاهر"]);
  assert.deepEqual(Object.keys(JSON.parse(snapshot.activity[0].details)).sort(), ["source", "summary"]);
  assert.ok(!JSON.stringify(snapshot).includes("+12025550101"));
  const full = getManagementSnapshot(db, admin);
  assert.equal(JSON.parse(full.activity[0].details).auditContext.sourceMessageId, "message-1");
});

test("strict basem/admin authority and live actor prevent spoofed or stale identities", t => {
  const db = fixture(t);
  assert.equal(isManagementAdmin(admin), true);
  assert.equal(isManagementAdmin({ ...member, id: "basem" }), false);
  denied(() => run(db, { action: "delete_task", taskId: "own" }, { ...admin, id: "fake-admin", name: "إدارة أخرى" }), "admin_required", 403);
  denied(() => run(db, { action: "delete_task", taskId: "own" }, { ...member, role: "admin" }), "actor_unavailable", 403);
  denied(() => run(db, { action: "comment", taskId: "own", comment: "x" }, { ...member, name: admin.name }), "actor_unavailable");
  db.prepare("UPDATE users SET active=0 WHERE id='member'").run();
  denied(() => run(db, { action: "submit", taskId: "own" }, member), "actor_unavailable");
  denied(() => getManagementSnapshot(db, member), "actor_unavailable");
  assert.equal(count(db, "audit_logs"), 0);
});

test("members cannot promote themselves through command fields or admin commands", t => {
  const db = fixture(t);
  for (const command of [
    { action: "add_task", title: "مهمة" }, { action: "edit_task", taskId: "own", title: "تعديل" },
    { action: "approve", taskId: "own" }, { action: "reject", taskId: "own", reason: "سبب" },
    { action: "reassign", taskId: "own", ownerId: "other" },
    { action: "archive_task", taskId: "own" }, { action: "restore_task", taskId: "own" },
    { action: "delete_task", taskId: "own" },
  ]) denied(() => run(db, command, member), "admin_required");
  for (const extra of [{ actor: admin }, { source: "whatsapp_secretary" }, { auditContext: {} }, { actorId: "basem" }]) {
    denied(() => parseManagementCommand({ action: "submit", taskId: "own", ...extra }), "invalid_fields");
  }
  assert.equal(count(db, "audit_logs"), 0);
});

test("assigned-only claim and cross-task access are enforced", t => {
  const db = fixture(t);
  for (const taskId of ["private", "unassigned", "absent"]) denied(() => run(db, { action: "claim", taskId }, member), "task_missing", 404);
  const result = run(db, { action: "claim", taskId: "assigned", expectedUpdatedAt: 100 }, member);
  assert.equal(result.action, "claim");
  assert.equal(row(db, "assigned").owner, member.name);
  assert.equal(row(db, "assigned").status, "progress");
  denied(() => run(db, { action: "claim", taskId: "assigned" }, member), "invalid_transition");
  denied(() => run(db, { action: "comment", taskId: "private", comment: "اختراق" }, member), "task_missing");
  assert.equal(canViewManagementTask(member, { owner: other.name, suggestedOwner: member.name }), false);
});

// A stale/duplicate poll tap on "claim" (the old bug where a swallowed resend
// left several copies of the same poll live, one of them tapped after the
// task had already moved on) must tell the tapper what actually happened --
// "already yours" or "already someone else's" -- not a generic "not
// available" that reads like the tap itself failed for no reason.
test("re-claiming an already-claimed task names who has it instead of a generic refusal", t => {
  const db = fixture(t);
  run(db, { action: "claim", taskId: "assigned" }, member);
  assert.throws(() => run(db, { action: "claim", taskId: "assigned" }, member),
    error => error instanceof ManagementActionError && error.code === "invalid_transition" && /أصلاً مستلمة عندك/.test(error.message));
  assert.throws(() => run(db, { action: "claim", taskId: "private" }, admin),
    error => error instanceof ManagementActionError && error.code === "invalid_transition" && error.message.includes(`أصلاً مستلمة من ${other.name}`));
});

test("comment records text without changing status; submit requires final admin approval", t => {
  const db = fixture(t);
  run(db, { action: "comment", taskId: "own", comment: "أنجزت جزءًا وباقي جزء" }, member);
  assert.equal(row(db).status, "progress");
  assert.equal(row(db).updated_at, 200);
  run(db, { action: "submit", taskId: "own", expectedUpdatedAt: 200 }, member);
  assert.equal(row(db).status, "approval"); assert.equal(row(db).completed_at, null);
  denied(() => run(db, { action: "comment", taskId: "own", comment: "بعد التسليم" }, member), "not_owned");
  run(db, { action: "approve", taskId: "own" });
  assert.equal(row(db).status, "completed"); assert.equal(row(db).completed_at, 200);
  assert.equal(count(db, "audit_logs"), 3);
});

test("reject and reopen implement bounded lifecycle and clear completion data", t => {
  const db = fixture(t);
  denied(() => run(db, { action: "approve", taskId: "own" }), "invalid_transition");
  run(db, { action: "submit", taskId: "own" }, member);
  run(db, { action: "reject", taskId: "own", reason: "ناقص التقرير" });
  assert.equal(row(db).status, "progress"); assert.equal(row(db).rejection_reason, "ناقص التقرير");
  run(db, { action: "submit", taskId: "own" }, member);
  run(db, { action: "approve", taskId: "own" });
  run(db, { action: "reopen", taskId: "own", reason: "تحديث جديد" });
  assert.equal(row(db).status, "progress"); assert.equal(row(db).completed_at, null);
  denied(() => run(db, { action: "reopen", taskId: "own" }), "invalid_transition");
});

test("release is allowed only before any progress since the claim", t => {
  const db = fixture(t);
  run(db, { action: "cancel_claim", taskId: "own" }, member);
  assert.equal(row(db).status, "open"); assert.equal(row(db).owner, null);
  run(db, { action: "claim", taskId: "own" }, member);
  run(db, { action: "comment", taskId: "own", comment: "بدأت" }, member);
  denied(() => run(db, { action: "cancel_claim", taskId: "own" }, member), "progress_exists");
  run(db, { action: "cancel_claim", taskId: "own" });
  assert.equal(row(db).status, "open");
});

test("a new attachment prevents release and older progress does not", t => {
  const db = fixture(t);
  db.exec("INSERT INTO comments (task_id,author,body,created_at) VALUES ('own','موظف تجريبي','قبل الاستلام',105)");
  run(db, { action: "cancel_claim", taskId: "own" }, member);
  run(db, { action: "claim", taskId: "own" }, member);
  db.exec("INSERT INTO attachments VALUES ('own-file','own','note.txt','text/plain',1,'own-key','موظف تجريبي',200)");
  denied(() => run(db, { action: "cancel_claim", taskId: "own" }, member), "progress_exists");
});

test("release of a legacy task remains atomic even when post-release visibility ends", t => {
  const db = fixture(t);
  db.exec("UPDATE tasks SET suggested_owner='موظف آخر' WHERE id='own'");
  run(db, { action: "cancel_claim", taskId: "own" }, member);
  assert.equal(row(db).owner, null);
  assert.equal(count(db, "audit_logs"), 1);
  assert.ok(!getManagementSnapshot(db, member).tasks.some(x => x.id === "own"));
});

test("stale task versions cause no changes or audit", t => {
  const db = fixture(t);
  for (const expected of [{ expectedUpdatedAt: 109 }, { expectedStatus: "open" }]) {
    denied(() => run(db, { action: "comment", taskId: "own", comment: "قديم", ...expected }, member), "stale", 409);
  }
  assert.equal(row(db).updated_at, 110); assert.equal(count(db, "audit_logs"), 0);
  run(db, { action: "comment", taskId: "own", comment: "حديث", expectedUpdatedAt: 110, expectedStatus: "progress" }, member);
  denied(() => run(db, { action: "submit", taskId: "own", expectedUpdatedAt: 110 }, member), "stale");
  assert.equal(row(db).status, "progress");
});

test("parallel proposals from the same snapshot cannot overwrite a newer edit", t => {
  const db = fixture(t);
  const first = getManagementSnapshot(db, admin).tasks.find(x => x.id === "own");
  run(db, { action: "edit_task", taskId: first.id, expectedUpdatedAt: first.updatedAt, title: "تعديل أول" });
  denied(() => run(db, { action: "edit_task", taskId: first.id, expectedUpdatedAt: first.updatedAt, title: "تعديل ثانٍ" }), "stale");
  assert.equal(row(db).title, "تعديل أول"); assert.equal(count(db, "audit_logs"), 1);
});

// A task no longer lives inside anything, so nothing outside it can block work
// on it: the old "المشروع ليس نشطًا" gate is gone, and every task in the
// fixture is immediately actionable by whoever it belongs to.
test("no containing entity can block work on a task anymore", t => {
  const db = fixture(t);
  run(db, { action: "submit", taskId: "blocked" }, member);
  assert.equal(row(db, "blocked").status, "approval");
  run(db, { action: "approve", taskId: "blocked" });
  assert.equal(row(db, "blocked").status, "completed");
  // Approving a task closes exactly that task (and auto-archives it), never a
  // containing entity alongside it.
  assert.ok(row(db, "blocked").archived_at);
  assert.equal(row(db, "own").status, "progress", "a sibling task is untouched");
  const message = db.prepare("SELECT details FROM audit_logs WHERE action='approve'").get().details;
  assert.doesNotMatch(message, /مشروع/);
});

test("create and partial edit validate assignment, date and priority without wiping other fields", t => {
  const db = fixture(t);
  const result = run(db, { action: "add_task", title: "مهمة جديدة", details: "تفاصيل", ownerId: "member", dueDate: "2026-09-08", priority: "red" });
  assert.equal(row(db, result.entityId).suggested_owner, member.name);
  run(db, { action: "edit_task", taskId: result.entityId, title: "اسم جديد" });
  assert.equal(row(db, result.entityId).details, "تفاصيل"); assert.equal(row(db, result.entityId).priority, "red");
  for (const fields of [{ dueDate: "2026-02-30" }, { priority: "critical" }, { ownerId: "missing" }, { ownerId: "member", suggestedOwner: other.name }]) {
    assert.throws(() => run(db, { action: "add_task", title: "مرفوض", ...fields }), ManagementActionError);
  }
  db.exec("UPDATE users SET active=0 WHERE id='other'");
  denied(() => run(db, { action: "reassign", taskId: "own", ownerId: "other" }), "assignee_unavailable");
  denied(() => run(db, { action: "edit_task", taskId: "own", ownerId: "member", suggestedOwner: other.name }), "assignee_unavailable");
  denied(() => run(db, { action: "edit_task", taskId: "own" }), "empty_edit");
});

test("reassignment resets lifecycle and changes member visibility without deleting history", t => {
  const db = fixture(t);
  run(db, { action: "comment", taskId: "own", comment: "عمل سابق" }, member);
  denied(() => run(db, { action: "edit_task", taskId: "own", ownerId: "other" }), "use_reassign");
  run(db, { action: "reassign", taskId: "own", ownerId: "other" });
  assert.equal(row(db).owner, null); assert.equal(row(db).suggested_owner, other.name); assert.equal(row(db).status, "open");
  assert.equal(count(db, "comments"), 2);
  assert.ok(!getManagementSnapshot(db, member).tasks.some(x => x.id === "own"));
  assert.ok(getManagementSnapshot(db, other).tasks.some(x => x.id === "own"));
  run(db, { action: "reassign", taskId: "own", ownerId: null });
  assert.equal(row(db).suggested_owner, null);
});

test("task archive prevents progress and restore preserves lifecycle", t => {
  const db = fixture(t);
  run(db, { action: "archive_task", taskId: "own" });
  denied(() => run(db, { action: "comment", taskId: "own", comment: "مرفوض" }, member), "task_archived");
  run(db, { action: "restore_task", taskId: "own" });
  assert.equal(row(db).archived_at, null); assert.equal(row(db).status, "progress");
  denied(() => run(db, { action: "restore_task", taskId: "own" }), "invalid_transition");
});

test("task deletion returns object keys, removes dependent records and retains audit", t => {
  const db = fixture(t);
  const result = run(db, { action: "delete_task", taskId: "private" });
  assert.deepEqual(result.deletedObjectKeys, ["private-object-key"]);
  assert.equal(row(db, "private"), undefined); assert.equal(count(db, "attachments"), 0); assert.equal(count(db, "comments"), 0);
  const detail = JSON.parse(db.prepare("SELECT details FROM audit_logs").get().details);
  assert.equal(detail.previous.id, "private"); assert.equal(detail.next, null);
});

test("audit failure rolls the mutation, its comment and its deletes back together", t => {
  const db = fixture(t); migrateManagementActions(db);
  db.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test-only failure'); END");
  assert.throws(() => run(db, { action: "comment", taskId: "own", comment: "لن يحفظ" }, member), /test-only failure/);
  assert.equal(count(db, "comments"), 1); assert.equal(row(db).updated_at, 110);
  assert.throws(() => run(db, { action: "delete_task", taskId: "private" }), /test-only failure/);
  assert.equal(count(db, "tasks"), 5); assert.equal(count(db, "attachments"), 1);
  assert.equal(db.isTransaction, false);
});

test("outer receipt transaction can roll action back and nested failure preserves outer work", t => {
  const db = fixture(t); migrateManagementActions(db);
  db.exec("CREATE TABLE receipts (id TEXT PRIMARY KEY); BEGIN IMMEDIATE; INSERT INTO receipts VALUES ('outer')");
  run(db, { action: "submit", taskId: "own" }, member);
  assert.equal(db.isTransaction, true); assert.equal(row(db).status, "approval");
  db.exec("ROLLBACK");
  assert.equal(row(db).status, "progress"); assert.equal(count(db, "receipts"), 0); assert.equal(count(db, "audit_logs"), 0);
  db.exec("BEGIN IMMEDIATE; INSERT INTO receipts VALUES ('kept')");
  denied(() => run(db, { action: "approve", taskId: "own" }), "invalid_transition");
  assert.equal(db.isTransaction, true); assert.equal(count(db, "receipts"), 1);
  db.exec("COMMIT"); assert.equal(count(db, "receipts"), 1);
});

test("migration inside outer rollback can be safely retried", t => {
  const db = fixture(t);
  db.exec("BEGIN IMMEDIATE"); migrateManagementActions(db); db.exec("ROLLBACK");
  assert.ok(!db.prepare("PRAGMA table_info(tasks)").all().some(x => x.name === "watcher"));
  run(db, { action: "submit", taskId: "own" }, member);
  assert.equal(row(db).status, "approval");
});

test("audit records DB-derived before/after and actor, whitelists server metadata", t => {
  const db = fixture(t);
  run(db, { action: "submit", taskId: "own" }, member, { source: "whatsapp_secretary", auditContext: {
    sourceMessageId: "message-id", origin: "whatsapp", senderNumber: "+12025550101", originalText: "خلصت المهمة",
    proposedCommand: { action: "submit", taskId: "own" }, confirmationRequired: false, confirmedBy: member.id,
    confirmationMessageId: null, previous: { status: "invented" }, next: { status: "invented" }, secret: "must-not-appear",
  } });
  const audit = db.prepare("SELECT * FROM audit_logs").get(); const details = JSON.parse(audit.details);
  assert.equal(audit.actor_name, member.name); assert.equal(audit.actor_user_id, member.id);
  assert.equal(details.previous.status, "progress"); assert.equal(details.next.status, "approval");
  assert.equal(details.auditContext.originalText, "خلصت المهمة");
  assert.ok(!audit.details.includes("invented") && !audit.details.includes("must-not-appear"));
});

test("oversized and malformed audit context is denied before any mutation", t => {
  const db = fixture(t); const cyclic = {}; cyclic.originalText = cyclic;
  for (const auditContext of [{ originalText: "x".repeat(25000) }, cyclic]) {
    denied(() => run(db, { action: "submit", taskId: "own" }, member, { auditContext }), "invalid_audit");
  }
  assert.equal(row(db).status, "progress"); assert.equal(count(db, "audit_logs"), 0);
});

test("validation never interpolates user fields into SQL or accepts malformed versions", t => {
  const db = fixture(t);
  for (const value of [null, [], "submit", { action: "__proto__" }, { action: "submit", taskId: "own", expectedUpdatedAt: "110" }]) assert.throws(() => parseManagementCommand(value), ManagementActionError);
  run(db, { action: "edit_task", taskId: "own", title: "'); DROP TABLE users; --" });
  assert.equal(count(db, "users"), 4); assert.equal(row(db).title, "'); DROP TABLE users; --");
  const before = plain(row(db));
  denied(() => run(db, { action: "edit_task", taskId: "own", dueDate: "not-a-date" }), "invalid_date");
  assert.deepEqual(plain(row(db)), before);
});

test("state route uses the shared engine/snapshot and preserves private responses and legacy PIN gate", () => {
  const source = readFileSync(new URL("../app/api/state/route.ts", import.meta.url), "utf8");
  assert.match(source, /executeManagementAction\(chatDatabase\(\), user, parseManagementCommand\(body\)/);
  assert.match(source, /getManagementSnapshot\(chatDatabase\(\), user\)/);
  assert.ok(!source.includes("UPDATE tasks SET") && !source.includes("DELETE FROM tasks"));
  assert.match(source, /result\.deletedObjectKeys\.map/);
  assert.match(source, /private, no-store, no-cache/);
  assert.doesNotMatch(source, /whatsappLoginSettings|whatsapp-login-settings/);
  // The "is this a genuinely fresh install?" probe keys off task history now
  // that projects no longer exist, and the route seeds tasks directly.
  assert.match(source, /entity_type = 'task' LIMIT 1/);
  assert.doesNotMatch(source, /project/i);
});

// A task opened/approved on the website dashboard used to notify no one --
// executeManagementAction()'s result.notification was silently discarded
// there ("Dashboard actions stay dashboard-only"). Basim asked that it reach
// the employee the same way a WhatsApp-driven action already does: a group
// notice plus a private claim/reject-with-comment/transfer poll. Locks in
// that the dashboard route now relays through the same dispatchManagementNotice
// the chat paths use, gated on result.notification, with a fresh post-action
// snapshot and the request body's ownerId carried through.
test("state route relays website task actions to the employee via dispatchManagementNotice, not just dashboard-local", () => {
  const source = readFileSync(new URL("../app/api/state/route.ts", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*dispatchManagementNotice.*\}\s*from\s*"@\/lib\/secretary-service"/);
  assert.match(source, /if\s*\(result\.notification\)\s*\{[\s\S]{0,400}dispatchManagementNotice\(/);
  assert.match(source, /getManagementSnapshot\(chatDatabase\(\), user\) as unknown as Snapshot/);
  assert.match(source, /ownerId:\s*typeof body\.ownerId === "string" \? body\.ownerId : null/);
});
