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
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'yellow',status TEXT NOT NULL,owner TEXT,
      suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),author TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT NOT NULL,action TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO users (id,name,role,active,pin_hash) VALUES ('basem','مدير تجريبي','admin',1,'private-hash'),('member','موظف تجريبي','member',1,NULL),('other','موظف آخر','member',1,NULL),('fake-admin','إدارة أخرى','admin',1,NULL);
    INSERT INTO projects (id,name,status,created_by,created_at) VALUES ('p','مشروع تجريبي','active','مدير تجريبي',100),('q','مشروع خاص','active','مدير تجريبي',100),('pending','مقترح','pending','مدير تجريبي',100);
    INSERT INTO tasks (id,project_id,title,status,owner,suggested_owner,started_at,created_at,updated_at) VALUES
      ('own','p','إنجاز تجريبي','progress','موظف تجريبي','موظف تجريبي',110,100,110),
      ('assigned','p','مقترحة للموظف','open',NULL,'موظف تجريبي',NULL,100,100),
      ('private','p','سرّي للموظف الآخر','progress','موظف آخر','موظف آخر',110,100,110),
      ('unassigned','q','غير معيّنة','open',NULL,NULL,NULL,100,100),
      ('blocked','pending','في مشروع معلّق','progress','موظف تجريبي','موظف تجريبي',110,100,110);
    INSERT INTO comments (task_id,author,body,created_at) VALUES ('private','موظف آخر','تفاصيل خاصة',120);
    INSERT INTO attachments VALUES ('file-private','private','private.pdf','application/pdf',5,'private-object-key','موظف آخر',120);`);
  return db;
}
const run = (db, command, actor = admin, options = {}) => executeManagementAction(db, actor, command, { now: 200, ...options });
const row = (db, id = "own") => db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const denied = (fn, code, status) => assert.throws(fn, error => error instanceof ManagementActionError && error.code === code && (!status || error.status === status));
const plain = value => JSON.parse(JSON.stringify(value));

test("additive migration is repeatable and snapshot has stable project versions", t => {
  const db = fixture(t);
  migrateManagementActions(db); migrateManagementActions(db);
  const snapshot = getManagementSnapshot(db, admin);
  assert.equal(snapshot.projects.find(p => p.id === "p").updatedAt, 100);
  assert.equal(snapshot.projects.find(p => p.id === "p").archivedAt, null);
  assert.equal(db.prepare("SELECT updated_at FROM projects WHERE id='p'").get().updated_at, null);
  assert.equal(count(db, "tasks"), 5);
  assert.ok(!JSON.stringify(snapshot).includes("private-hash"));
});

test("member snapshot scopes projects, tasks, files, comments, users and audit metadata", t => {
  const db = fixture(t);
  run(db, { action: "comment", taskId: "own", comment: "تحديث ظاهر" }, member, {
    source: "whatsapp_secretary", auditContext: { originalText: "نص كامل", senderNumber: "+12025550101", sourceMessageId: "message-1" },
  });
  const snapshot = getManagementSnapshot(db, member);
  assert.deepEqual(snapshot.tasks.map(x => x.id).sort(), ["assigned", "blocked", "own"]);
  assert.deepEqual(snapshot.projects.map(x => x.id).sort(), ["p", "pending"]);
  assert.deepEqual(snapshot.users.map(x => x.id), ["member"]);
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
  denied(() => run(db, { action: "add_project", name: "ممنوع" }, { ...admin, id: "fake-admin", name: "إدارة أخرى" }), "admin_required", 403);
  denied(() => run(db, { action: "add_project", name: "ممنوع" }, { ...member, role: "admin" }), "actor_unavailable", 403);
  denied(() => run(db, { action: "comment", taskId: "own", comment: "x" }, { ...member, name: admin.name }), "actor_unavailable");
  db.prepare("UPDATE users SET active=0 WHERE id='member'").run();
  denied(() => run(db, { action: "submit", taskId: "own" }, member), "actor_unavailable");
  denied(() => getManagementSnapshot(db, member), "actor_unavailable");
  assert.equal(count(db, "audit_logs"), 0);
});

test("members cannot promote themselves through command fields or admin commands", t => {
  const db = fixture(t);
  for (const command of [
    { action: "add_project", name: "مشروع" }, { action: "edit_project", projectId: "p", name: "تعديل" },
    { action: "add_task", projectId: "p", title: "مهمة" }, { action: "edit_task", taskId: "own", title: "تعديل" },
    { action: "approve", taskId: "own" }, { action: "reject", taskId: "own", reason: "سبب" },
    { action: "reassign", taskId: "own", ownerId: "other" }, { action: "move_task", taskId: "own", projectId: "q" },
    { action: "archive_task", taskId: "own" }, { action: "restore_task", taskId: "own" },
    { action: "delete_task", taskId: "own" }, { action: "delete_project", projectId: "p" },
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

test("stale task and project versions cause no changes or audit", t => {
  const db = fixture(t);
  for (const expected of [
    { expectedUpdatedAt: 109 }, { expectedStatus: "open" }, { expectedProjectId: "q" },
    { expectedProjectUpdatedAt: 101 }, { expectedProjectStatus: "pending" },
  ]) denied(() => run(db, { action: "comment", taskId: "own", comment: "قديم", ...expected }, member), "stale", 409);
  assert.equal(row(db).updated_at, 110); assert.equal(count(db, "audit_logs"), 0);
  run(db, { action: "comment", taskId: "own", comment: "حديث", expectedUpdatedAt: 110, expectedProjectUpdatedAt: 100 }, member);
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

test("project create edit archive restore uses versioned state and preserves prior status", t => {
  const db = fixture(t);
  const created = run(db, { action: "add_project", name: "مشروع جديد" });
  run(db, { action: "edit_project", projectId: created.entityId, name: "اسم أحدث", expectedUpdatedAt: 200 });
  run(db, { action: "archive_project", projectId: created.entityId, expectedUpdatedAt: 201 });
  let project = getManagementSnapshot(db, admin).projects.find(p => p.id === created.entityId);
  assert.equal(project.status, "archived"); assert.equal(project.updatedAt, 202);
  denied(() => run(db, { action: "add_task", projectId: created.entityId, title: "ممنوع" }), "project_inactive");
  run(db, { action: "restore_project", projectId: created.entityId, expectedStatus: "archived", expectedUpdatedAt: 202 });
  project = getManagementSnapshot(db, admin).projects.find(p => p.id === created.entityId);
  assert.equal(project.status, "active"); assert.equal(project.name, "اسم أحدث");
  run(db, { action: "archive_project", projectId: "pending" });
  run(db, { action: "restore_project", projectId: "pending" });
  assert.equal(getManagementSnapshot(db, admin).projects.find(p => p.id === "pending").status, "pending");
});

test("project reject restore approve and inactive guard are enforced", t => {
  const db = fixture(t);
  denied(() => run(db, { action: "submit", taskId: "blocked" }, member), "project_inactive");
  run(db, { action: "approve_project", projectId: "pending" });
  run(db, { action: "submit", taskId: "blocked" }, member);
  run(db, { action: "reject_project", projectId: "pending", reason: "نقص معلومات" });
  run(db, { action: "restore_project", projectId: "pending" });
  assert.equal(db.prepare("SELECT status,rejection_reason FROM projects WHERE id='pending'").get().status, "pending");
  run(db, { action: "approve_project", projectId: "pending" });
  denied(() => run(db, { action: "approve_project", projectId: "pending" }), "invalid_transition");
});

test("create and partial edit validate assignment, date and priority without wiping other fields", t => {
  const db = fixture(t);
  const result = run(db, { action: "add_task", projectId: "p", title: "مهمة جديدة", details: "تفاصيل", ownerId: "member", dueDate: "2026-09-08", priority: "red" });
  assert.equal(row(db, result.entityId).suggested_owner, member.name);
  run(db, { action: "edit_task", taskId: result.entityId, title: "اسم جديد" });
  assert.equal(row(db, result.entityId).details, "تفاصيل"); assert.equal(row(db, result.entityId).priority, "red");
  for (const fields of [{ dueDate: "2026-02-30" }, { priority: "critical" }, { ownerId: "missing" }, { ownerId: "member", suggestedOwner: other.name }]) {
    assert.throws(() => run(db, { action: "add_task", projectId: "p", title: "مرفوض", ...fields }), ManagementActionError);
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

test("move validates both projects and retains task status, comments and ownership", t => {
  const db = fixture(t);
  denied(() => run(db, { action: "move_task", taskId: "own", projectId: "q", expectedTargetProjectUpdatedAt: 99 }), "stale");
  denied(() => run(db, { action: "move_task", taskId: "own", projectId: "pending" }), "project_inactive");
  run(db, { action: "move_task", taskId: "own", projectId: "q", expectedProjectUpdatedAt: 100, expectedTargetProjectUpdatedAt: 100 });
  assert.equal(row(db).project_id, "q"); assert.equal(row(db).owner, member.name); assert.equal(row(db).status, "progress");
  const snapshot = getManagementSnapshot(db, admin);
  assert.equal(snapshot.projects.find(p => p.id === "p").updatedAt, 200);
  assert.equal(snapshot.projects.find(p => p.id === "q").updatedAt, 200);
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

test("project deletion removes children atomically but never touches object storage itself", t => {
  const db = fixture(t);
  const result = run(db, { action: "delete_project", projectId: "p" });
  assert.deepEqual(result.deletedObjectKeys, ["private-object-key"]);
  assert.equal(count(db, "tasks"), 2); assert.equal(count(db, "attachments"), 0); assert.equal(count(db, "comments"), 0);
  assert.equal(db.prepare("SELECT id FROM projects WHERE id='p'").get(), undefined);
  assert.equal(db.prepare("SELECT entity_type FROM audit_logs").get().entity_type, "project");
});

test("audit failure rolls mutation, comment, project version and deletes back together", t => {
  const db = fixture(t); migrateManagementActions(db);
  db.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test-only failure'); END");
  assert.throws(() => run(db, { action: "comment", taskId: "own", comment: "لن يحفظ" }, member), /test-only failure/);
  assert.equal(count(db, "comments"), 1); assert.equal(row(db).updated_at, 110);
  assert.equal(db.prepare("SELECT updated_at FROM projects WHERE id='p'").get().updated_at, null);
  assert.throws(() => run(db, { action: "delete_project", projectId: "p" }), /test-only failure/);
  assert.equal(count(db, "tasks"), 5); assert.equal(count(db, "attachments"), 1); assert.equal(count(db, "projects"), 3);
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
  assert.ok(!db.prepare("PRAGMA table_info(projects)").all().some(x => x.name === "updated_at"));
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
  assert.match(source, /entity_type = 'project' LIMIT 1/);
});
