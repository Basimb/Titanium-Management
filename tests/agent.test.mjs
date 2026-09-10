import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { executeManagementAction, getManagementSnapshot, migrateManagementActions, ManagementActionError } from "../lib/management-actions.ts";
import { decideApproval, findPendingApproval, listApprovals, requestDeadlineExtension, requestProjectClose, requestProjectCreate, requestTaskClose, requestTaskOwnership, requestTaskTransfer, staleApprovals } from "../lib/approvals.ts";
import { can, capabilities, inScope } from "../lib/permissions.ts";
import { activeRules, policyViolations, proposeRuleFromStatement, recordCorrection, suggestOwner, CORRECTION_THRESHOLD } from "../lib/rules.ts";
import { addKnowledge, searchKnowledge, formatKnowledgeHits } from "../lib/knowledge.ts";
import { createFollowupJobs, enqueueAgentMessage, planFollowups } from "../lib/agent-followups.ts";
import { handleAgentIntent, parseProjectTaskLines, createProjectBundle } from "../lib/secretary-agent.ts";
import { emptySecretaryIntent } from "../lib/secretary-intent.ts";
import { migrateSecretaryChoices, peekSecretaryChoiceField } from "../lib/secretary-choices.ts";
import { groupBudgetRemaining, isGroupWorthy, GROUP_DAILY_BUDGET } from "../lib/team-chat-policy.ts";

const owner = { id: "basem", name: "باسم", role: "admin", active: 1 };
const khaled = { id: "khaled", name: "خالد", role: "member", active: 1 };
const shadi = { id: "shadi", name: "شادي", role: "member", active: 1 };
const manager = { id: "mgr", name: "مدير القسم", role: "manager", active: 1 };
const T0 = 1_760_000_000_000;

test('followup worker initializes queue tables before first delivery on an upgraded database', async t => {
  const db = fixture(t);
  db.exec('DROP TABLE agent_outbox; DROP TABLE agent_followups;');
  const jobs = createFollowupJobs({ db, config: { enabled: true, contacts: [] }, now: () => Date.parse('2026-09-06T20:00:00Z') });
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail('No message expected outside working hours')), { status: 'idle' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_outbox').get().n, 0);
});

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL,pin_salt TEXT,pin_hash TEXT,created_at INTEGER DEFAULT 1,updated_at INTEGER DEFAULT 1);
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'yellow',status TEXT NOT NULL,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),author TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO users (id,name,role,active) VALUES ('basem','باسم','admin',1),('khaled','خالد','member',1),('shadi','شادي','member',1),('mgr','مدير القسم','manager',1);
    INSERT INTO projects (id,name,status,created_by,created_at) VALUES ('p','ترخيص دابوق','active','باسم',100);
    INSERT INTO tasks (id,project_id,title,status,owner,due_date,created_at,updated_at,started_at) VALUES ('t1','p','متابعة عقد الإيجار','progress','خالد','2026-09-06',100,100,100),('t2','p','الأوراق الحكومية','open',NULL,NULL,100,100,NULL);
  `);
  migrateManagementActions(db);
  return db;
}

test("agent schema migration is idempotent and adds columns/tables", t => {
  const db = fixture(t);
  migrateManagementActions(db); migrateManagementActions(db);
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map(row => row.name);
  for (const column of ["watcher", "expected_at", "blocker", "last_update_at"]) assert.ok(taskColumns.includes(column), column);
  for (const table of ["approvals", "rules", "corrections", "knowledge", "knowledge_fts", "agent_outbox", "agent_followups"]) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), table);
});

test("permission matrix: owner everything, manager creates, member only own work", () => {
  assert.ok(can(owner, "approval.decide"));
  assert.ok(can(manager, "project.create") && !can(manager, "approval.decide") && !can(manager, "task.delete"));
  assert.ok(can(khaled, "task.claim") && !can(khaled, "project.create") && !can(khaled, "task.approve"));
  assert.equal(capabilities({ ...khaled, active: 0 }).size, 0);
  assert.ok(inScope(khaled, { owner: "خالد", suggestedOwner: null }));
  assert.ok(!inScope(khaled, { owner: "شادي", suggestedOwner: null }));
  assert.ok(inScope(khaled, { owner: "شادي", suggestedOwner: null, watcher: "خالد" }));
  // Closing a project always needs Basim's decision now, even for a manager who
  // used to archive directly -- see project.archive moving to OWNER_ONLY.
  assert.ok(can(owner, "project.archive") && !can(manager, "project.archive"));
});

test("member cannot edit deadlines directly; extension request goes to owner and applies on approval", t => {
  const db = fixture(t);
  assert.throws(() => executeManagementAction(db, khaled, { action: "edit_task", taskId: "t1", dueDate: "2026-09-07" }, { now: T0 }), ManagementActionError);
  const { approval, ownerMessage } = requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-07", reason: "تأخر المحامي" }, { now: T0 });
  assert.equal(approval.status, "pending"); assert.match(ownerMessage, /خالد طلب تمديد/);
  assert.equal(db.prepare("SELECT due_date FROM tasks WHERE id='t1'").get().due_date, "2026-09-06", "task unchanged before decision");
  assert.throws(() => requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-08", reason: "x" }, { now: T0 }), /مماثل/);
  assert.throws(() => decideApproval(db, khaled, { approvalId: approval.id, decision: "approved" }, { now: T0 + 1 }), ManagementActionError);
  assert.equal(listApprovals(db, khaled).length, 1, "requester sees own request");
  assert.equal(listApprovals(db, shadi).length, 0, "others do not");
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 1 });
  assert.equal(decision.approval.status, "approved");
  assert.equal(db.prepare("SELECT due_date FROM tasks WHERE id='t1'").get().due_date, "2026-09-07");
  assert.match(decision.notifyRequester, /وافق باسم/); assert.match(decision.notifyGroup, /مُدّد/);
  assert.throws(() => decideApproval(db, owner, { approvalId: approval.id, decision: "rejected" }, { now: T0 + 2 }), /حُسم/);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('request_approval','approve_request')").get().n >= 2);
});

// Basim's complaint: proactive approval requests (deadline extension, task
// close, ownership, transfer, project close/create, task create) only ever
// arrived as a plain-text "اعتمد"/"ارفض" instruction with nothing to tap.
// Every request* function now also returns a real tappable poll whose own
// option ids embed the approval id -- see approvalDecisionPoll -- so a tap
// resolves deterministically, and WhatsApp itself refuses a poll that
// outlives an hour, so expiresAt must never exceed that.
test("every proactive approval request attaches a tappable poll keyed to its own approval id, capped at a 1-hour expiry", t => {
  const db = fixture(t);
  const extension = requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-07", reason: "تأخر المحامي" }, { now: T0 });
  assert.equal(extension.choices.id, `APR${extension.approval.id}`);
  assert.deepEqual(extension.choices.options.map(option => option.id), [`APR${extension.approval.id}Y`, `APR${extension.approval.id}N`]);
  assert.equal(extension.choices.expiresAt, T0 + 60 * 60_000);
  const ownership = requestTaskOwnership(db, khaled, { taskId: "t2" }, { now: T0 + 1 });
  assert.equal(ownership.choices.id, `APR${ownership.approval.id}`);
  assert.equal(ownership.choices.expiresAt, T0 + 1 + 60 * 60_000);
  const close = requestTaskClose(db, khaled, { taskId: "t1", result: "خلص" }, { now: T0 + 2 });
  assert.equal(close.choices.id, `APR${close.approval.id}`);
  assert.notEqual(close.choices.id, ownership.choices.id, "each approval gets its own poll id, never a shared one");
});

test("employee ownership request waits for Basim and assigns only after approval", t => {
  const db = fixture(t);
  const { approval, ownerMessage } = requestTaskOwnership(db, khaled, { taskId: "t2", reason: "أقدر أتابع الأوراق" }, { now: T0 });
  assert.equal(approval.type, "task_ownership");
  assert.match(ownerMessage, /خالد يطلب مسؤولية/);
  assert.equal(db.prepare("SELECT owner,suggested_owner FROM tasks WHERE id='t2'").get().suggested_owner, null);
  assert.throws(() => requestTaskOwnership(db, khaled, { taskId: "t2" }, { now: T0 + 1 }), /مماثل/);
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 2 });
  const task = db.prepare("SELECT status,owner,suggested_owner FROM tasks WHERE id='t2'").get();
  assert.equal(task.status, "open"); assert.equal(task.owner, null); assert.equal(task.suggested_owner, "خالد");
  assert.match(decision.notifyRequester, /وافق باسم/);
});

test("ownership approval refuses to overwrite a task changed after the request", t => {
  const db = fixture(t);
  const { approval } = requestTaskOwnership(db, khaled, { taskId: "t2" }, { now: T0 });
  db.prepare("UPDATE tasks SET suggested_owner='شادي',updated_at=? WHERE id='t2'").run(T0 + 1);
  assert.throws(() => decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 2 }), /تغيّرت البيانات/);
  assert.equal(db.prepare("SELECT status FROM approvals WHERE id=?").get(approval.id).status, "pending");
});

test("task close request moves to approval; rejection returns it with the reason", t => {
  const db = fixture(t);
  const { approval } = requestTaskClose(db, khaled, { taskId: "t1", result: "تم توقيع العقد" }, { now: T0 });
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='t1'").get().status, "approval");
  assert.ok(db.prepare("SELECT body FROM comments WHERE task_id='t1'").get().body.includes("تم توقيع العقد"));
  const rejected = decideApproval(db, owner, { approvalId: approval.id, decision: "rejected", note: "ناقص نسخة العقد" }, { now: T0 + 1 });
  assert.equal(db.prepare("SELECT status,rejection_reason FROM tasks WHERE id='t1'").get().rejection_reason, "ناقص نسخة العقد");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='t1'").get().status, "progress");
  assert.match(rejected.notifyRequester, /لم يعتمد/);
});

test("manager project goes pending; project_create approval creates project with tasks", t => {
  const db = fixture(t);
  const created = executeManagementAction(db, manager, { action: "add_project", name: "مشروع المدير" }, { now: T0 });
  assert.equal(db.prepare("SELECT status FROM projects WHERE id=?").get(created.entityId).status, "pending");
  const { approval } = requestProjectCreate(db, manager, { name: "تجهيز دابوق", goal: "افتتاح", tasks: [{ title: "البضاعة", ownerId: "khaled", priority: "red" }, { title: "اللوحة", ownerId: "shadi", priority: "yellow", dueDate: "2026-09-20" }] }, { now: T0 });
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 1 });
  const project = db.prepare("SELECT id,status FROM projects WHERE name='تجهيز دابوق'").get();
  assert.equal(project.status, "active");
  const tasks = db.prepare("SELECT title,suggested_owner,priority FROM tasks WHERE project_id=? ORDER BY created_at").all(project.id);
  assert.deepEqual(tasks.map(task => [task.title, task.suggested_owner, task.priority]), [["البضاعة", "خالد", "red"], ["اللوحة", "شادي", "yellow"]]);
  assert.match(decision.notifyGroup, /مشروع جديد/);
});

test("a manager can no longer archive a project directly; must request Basim's approval", t => {
  const db = fixture(t);
  assert.throws(() => executeManagementAction(db, manager, { action: "archive_project", projectId: "p" }, { now: T0 }), ManagementActionError);
  const { approval, ownerMessage } = requestProjectClose(db, manager, { projectId: "p", reason: "خلصت الرخصة" }, { now: T0 });
  assert.equal(approval.type, "project_close");
  assert.match(ownerMessage, /مدير القسم يطلب إغلاق مشروع/);
  // t1 and t2 are both still open in the fixture -- Basim should see that
  // before deciding blind, since archiving never blocks on it.
  assert.match(ownerMessage, /لسا فيه مهمتين مفتوحة/);
  assert.equal(db.prepare("SELECT archived_at FROM projects WHERE id='p'").get().archived_at, null);
  assert.throws(() => requestProjectClose(db, manager, { projectId: "p" }, { now: T0 + 1 }), /مماثل/);
  assert.throws(() => requestProjectClose(db, owner, { projectId: "p" }, { now: T0 + 1 }), ManagementActionError);
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 2 });
  assert.ok(db.prepare("SELECT archived_at FROM projects WHERE id='p'").get().archived_at);
  assert.match(decision.notifyGroup, /اعتُمد إغلاق مشروع/);
});

test("project close request says all tasks are done when none are left open", t => {
  const db = fixture(t);
  db.prepare("UPDATE tasks SET status='completed' WHERE project_id='p'").run();
  const { ownerMessage } = requestProjectClose(db, manager, { projectId: "p" }, { now: T0 });
  assert.match(ownerMessage, /كل مهام المشروع منتهية/);
  assert.doesNotMatch(ownerMessage, /مفتوحة/);
});

test("employee transfers their own task to a named colleague; nothing changes before Basim decides", t => {
  const db = fixture(t);
  // شادي merely watches t1 (so it is visible to him) but is not its owner --
  // only the actual owner/suggested owner may request its transfer.
  db.prepare("UPDATE tasks SET watcher='شادي' WHERE id='t1'").run();
  assert.throws(() => requestTaskTransfer(db, shadi, { taskId: "t1", suggestedOwnerId: "khaled" }, { now: T0 }), /متاح للمسؤول عنها فقط/);
  const { approval, ownerMessage } = requestTaskTransfer(db, khaled, { taskId: "t1", suggestedOwnerId: "shadi", reason: "مشغول بمهمة أخرى" }, { now: T0 });
  assert.equal(approval.type, "task_transfer");
  assert.match(ownerMessage, /خالد بده يحوّل مهمة/);
  assert.equal(db.prepare("SELECT owner FROM tasks WHERE id='t1'").get().owner, "خالد");
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 1 });
  const task = db.prepare("SELECT status,owner,suggested_owner FROM tasks WHERE id='t1'").get();
  assert.equal(task.status, "open"); assert.equal(task.owner, null); assert.equal(task.suggested_owner, "شادي");
  assert.match(decision.notifyGroup, /حُوّلت مهمة/);
  // شادي is the one actually receiving the task, not the requester (خالد) --
  // decideApproval must tell him directly, on top of the group notice and
  // خالد's own "your request was approved" message, or a task lands on him
  // with zero heads-up (the same silent-notification gap Basim keeps hitting).
  assert.equal(decision.notifyExtra.length, 1);
  assert.equal(decision.notifyExtra[0].userId, "shadi");
  assert.match(decision.notifyExtra[0].text, /عيّن لك باسم مهمة/);
});

test("declining a task (no suggested colleague) notifies nobody extra beyond the group and the requester", t => {
  const db = fixture(t);
  const { approval, ownerMessage } = requestTaskTransfer(db, khaled, { taskId: "t1", reason: "مش مسؤوليتي" }, { now: T0 });
  assert.match(ownerMessage, /خالد يقول إن مهمة.*مش مسؤوليته/);
  assert.throws(() => requestTaskTransfer(db, khaled, { taskId: "t1", suggestedOwnerId: "shadi" }, { now: T0 + 1 }), /مماثل/);
  const decision = decideApproval(db, owner, { approvalId: approval.id, decision: "approved" }, { now: T0 + 1 });
  assert.deepEqual(decision.notifyExtra, []);
  const task = db.prepare("SELECT status,owner,suggested_owner FROM tasks WHERE id='t1'").get();
  assert.equal(task.owner, null); assert.equal(task.suggested_owner, null); assert.equal(task.status, "open");
});

test("agent kinds: project_close_request and task_transfer_request file requests for non-owners, clarify for Basim", t => {
  const db = fixture(t);
  const ctx = { db, actor: manager, now: T0, users: [owner, khaled, shadi, manager], tasks: [], projects: [{ id: "p", name: "ترخيص دابوق", status: "active" }],
    stash: () => { throw new Error("must not stash"); } };
  const closeResult = handleAgentIntent({ ...emptySecretaryIntent("project_close_request"), projectId: "p" }, ctx);
  assert.equal(closeResult.status, "applied");
  assert.match(closeResult.reply, /رفعت طلب إغلاق مشروع/);
  assert.equal(closeResult.notify[0].userId, "basem");
  const asOwner = handleAgentIntent({ ...emptySecretaryIntent("project_close_request"), projectId: "p" }, { ...ctx, actor: owner });
  assert.equal(asOwner.status, "clarify");
  const transferResult = handleAgentIntent({ ...emptySecretaryIntent("task_transfer_request"), taskId: "t1", fields: { ...emptySecretaryIntent().fields, ownerId: "shadi" } }, { ...ctx, actor: khaled });
  assert.equal(transferResult.status, "applied");
  assert.match(transferResult.reply, /رفعت طلب التحويل/);
});

test("findPendingApproval resolves by requester name and type words", t => {
  const db = fixture(t);
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-07", reason: "x" }, { now: T0 });
  db.prepare("UPDATE tasks SET owner='شادي',status='progress' WHERE id='t2'").run();
  requestTaskClose(db, shadi, { taskId: "t2", result: "تم" }, { now: T0 });
  assert.equal(findPendingApproval(db, owner, { requesterName: "خالد" }).approval.type, "deadline_extension");
  assert.equal(findPendingApproval(db, owner, { text: "اعتمد اغلاق مهمة شادي" }).approval.type, "task_close");
  assert.equal(findPendingApproval(db, owner, {}).approval, null);
  assert.equal(findPendingApproval(db, owner, {}).candidates.length, 2);
});

test("findPendingApproval tells a project closure apart from a task closure, and finds a transfer by text", t => {
  // "سكر/اغلاق مشروع..." must resolve to project_close, never task_close --
  // the two heuristics share the word "اغلاق", so the مشروع+اغلاق check has to
  // run before the bare اغلاق check, or every project closure would be
  // mistaken for closing a random task instead.
  const db = fixture(t);
  const { approval: taskCloseApproval } = requestTaskClose(db, khaled, { taskId: "t1", result: "خلصت المتابعة" }, { now: T0 });
  const { approval: projectCloseApproval } = requestProjectClose(db, manager, { projectId: "p", reason: "خلص الترخيص" }, { now: T0 + 1 });
  db.prepare("UPDATE tasks SET owner='شادي' WHERE id='t2'").run();
  const { approval: transferApproval } = requestTaskTransfer(db, shadi, { taskId: "t2", suggestedOwnerId: "khaled" }, { now: T0 + 2 });
  assert.equal(findPendingApproval(db, owner, { text: "اعتمد اغلاق مشروع دابوق" }).approval.id, projectCloseApproval.id);
  assert.equal(findPendingApproval(db, owner, { text: "اعتمد اغلاق مهمة عقد الايجار" }).approval.id, taskCloseApproval.id);
  assert.equal(findPendingApproval(db, owner, { text: "اعتمد تحويل المهمة لخالد" }).approval.id, transferApproval.id);
});

test("stale approvals are surfaced once per day and expired after TTL", t => {
  const db = fixture(t);
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-07", reason: "x" }, { now: T0 });
  assert.equal(staleApprovals(db, T0 + 60_000, 2 * 86_400_000).length, 0);
  assert.equal(staleApprovals(db, T0 + 3 * 86_400_000, 2 * 86_400_000).length, 1);
  assert.equal(staleApprovals(db, T0 + 20 * 86_400_000, 2 * 86_400_000).length, 0);
  assert.equal(db.prepare("SELECT status FROM approvals").get().status, "expired");
});

test("rules: repeated corrections propose a rule; approved rule suggests owner; policy blocks", t => {
  const db = fixture(t);
  let proposal = null;
  for (let index = 0; index < CORRECTION_THRESHOLD; index += 1) {
    const outcome = recordCorrection(db, owner, { category: "assignment", from: "أيمن", to: "شادي", context: "اللوحات", keywords: ["لوحة", "لوحات"] }, { now: T0 + index });
    proposal = outcome.proposal ?? proposal;
    if (index < CORRECTION_THRESHOLD - 1) assert.equal(outcome.proposal, null);
  }
  assert.ok(proposal, "third correction proposes a rule");
  assert.equal(activeRules(db).length, 0, "nothing active before owner approval");
  decideApproval(db, owner, { approvalId: proposal.approval.id, decision: "approved" }, { now: T0 + 10 });
  assert.equal(activeRules(db).length, 1);
  assert.equal(suggestOwner(db, { text: "تركيب لوحة الصيدلية" })?.ownerId, "شادي");
  assert.equal(suggestOwner(db, { text: "متابعة الكهرباء" }), null);
  const policy = proposeRuleFromStatement(db, owner, { statement: "لا مهمة بدون موعد", keywords: [], policy: { requireDueDate: true } }, { now: T0 + 11 });
  decideApproval(db, owner, { approvalId: policy.approval.id, decision: "approved" }, { now: T0 + 12 });
  assert.equal(policyViolations(db, { title: "x", dueDate: null }).length, 1);
  assert.equal(policyViolations(db, { title: "x", dueDate: "2026-10-01" }).length, 0);
  assert.equal(recordCorrection(db, khaled, { category: "assignment", from: "a", to: "b", context: "" }).count, 0, "members cannot record corrections");
});

test("knowledge: FTS search with visibility scoping, checked by the agent before web search", t => {
  const db = fixture(t);
  addKnowledge(db, owner, { title: "خطوات ترخيص صيدلية", body: "أولًا نقابة الصيادلة ثم وزارة الصحة ثم البلدية", category: "licensing" }, { now: T0 });
  addKnowledge(db, owner, { title: "ملاحظة خاصة", body: "رواتب الموظفين", visibility: "owner" }, { now: T0 });
  assert.throws(() => addKnowledge(db, khaled, { title: "x", body: "y" }), /forbidden/);
  assert.equal(searchKnowledge(db, khaled, "ترخيص صيدلية").length, 1);
  assert.equal(searchKnowledge(db, khaled, "رواتب").length, 0, "owner-only entries hidden");
  assert.equal(searchKnowledge(db, owner, "رواتب").length, 1);
  const result = handleAgentIntent({ kind: "knowledge", intakeMode: null, action: null, taskId: null, projectId: null, recipientIds: [], message: "كيف نرخص صيدلية", fields: { title: null, name: null, details: null, priority: null, dueDate: null, ownerId: null, reason: null, body: null, remindAt: null } },
    { db, actor: khaled, now: T0, users: [], tasks: [], projects: [], stash: () => "T1" });
  assert.match(result.reply, /نقابة الصيادلة/);
});
// A short reference-list entry (Basim's real "دليل أوامر تيتانيوم" case) used
// to come back as a truncated FTS snippet -- cut off mid-list, with no way
// for a plain "وين الباقي؟" follow-up to recover the rest since nothing ties
// that question back to a specific truncated answer. formatKnowledgeHits now
// shows the FULL body for a normal-sized entry, and only degrades to a hard
// cutoff once the combined reply would exceed a WhatsApp-reasonable budget.
test("knowledge answers show the full body, not a truncated FTS snippet, unless the reply would get too long", t => {
  const db = fixture(t);
  const guide = "قائمة «أوامر» واتساب لتيتانيوم مرتبة حسب مراحل المهمة:\n🔵 إنشاء: افتح مشروع جديد / اضافة مهمة\n🟢 استلام وتنفيذ: استلمت / رجّع الاستلام\n🟡 تحديث ومتابعة: اضافة ملاحظة\n🟠 تحويل وتمديد: تحويل المهمة\n🟣 إنهاء واعتماد: انهاء المهمة";
  addKnowledge(db, owner, { title: "دليل أوامر تيتانيوم", body: guide }, { now: T0 });
  const hits = searchKnowledge(db, owner, "دليل أوامر تيتانيوم");
  assert.equal(hits.length, 1);
  const formatted = formatKnowledgeHits(hits);
  assert.match(formatted, /📌 دليل أوامر تيتانيوم/);
  assert.match(formatted, /تحديث ومتابعة: اضافة ملاحظة/, "the tail of the list must survive, not just the FTS match window");
  assert.match(formatted, /إنهاء واعتماد: انهاء المهمة/, "the very last line must not be clipped");
  // Multiple long entries together must still hard-stop at the budget rather
  // than silently producing one giant WhatsApp message.
  addKnowledge(db, owner, { title: "سياسة طويلة", body: "س".repeat(4000) }, { now: T0 + 1 });
  const long = formatKnowledgeHits(searchKnowledge(db, owner, "دليل سياسة", 5));
  assert.ok(long.length <= 3510, `expected a hard cap near 3500 chars, got ${long.length}`);
  assert.match(long, /…$/);
});

test("agent handler: employee extension files a request and notifies owner; owner gets confirmation token instead", t => {
  const db = fixture(t);
  const base = { intakeMode: null, action: null, projectId: null, recipientIds: [], message: null, fields: { title: null, name: null, details: null, priority: null, dueDate: "2026-09-08", ownerId: null, reason: "المحامي", body: null, remindAt: null } };
  const snapshot = getManagementSnapshot(db, owner);
  const ctx = actor => ({ db, actor, now: T0, users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: () => "TABC" });
  const member = handleAgentIntent({ ...base, kind: "extension", taskId: "t1" }, ctx(khaled));
  assert.equal(member.status, "applied"); assert.equal(member.notify[0].userId, "basem");
  assert.equal(listApprovals(db, owner).length, 1);
  const boss = handleAgentIntent({ ...base, kind: "extension", taskId: "t1" }, ctx(owner));
  assert.equal(boss.status, "confirmation"); assert.match(boss.reply, /TABC/);
  const list = handleAgentIntent({ ...base, kind: "approvals", taskId: null }, ctx(owner));
  assert.match(list.reply, /بانتظار قرارك/);
  const decide = handleAgentIntent({ ...base, kind: "decide", action: "approve", taskId: null, message: "تمديد خالد" }, ctx(owner));
  assert.equal(decide.status, "applied"); assert.equal(db.prepare("SELECT due_date FROM tasks WHERE id='t1'").get().due_date, "2026-09-08");
  const voiceDecide = handleAgentIntent({ ...base, kind: "decide", action: "reject", taskId: null, message: "الأول" }, { ...ctx(owner), inputKind: "voice" });
  assert.equal(voiceDecide.status, "clarify", "nothing pending after decision");
});

// Basim reported that "ارفض الاول"/"رفض رقم 1" kept coming back with the exact
// same "في أكثر من طلب مطابق" list no matter what he typed next, whenever two
// or more unrelated requests were pending together. Root cause: the ordinal
// word he actually typed only ever reached handleAgentIntent through the
// model-generated plan.message field (its own paraphrase of his message),
// never through his verbatim text -- so a paraphrase that dropped or reworded
// the ordinal made every retry fail identically. ctx.text now carries the
// real WhatsApp text and is checked first.
test("decide resolves an ordinal from the admin's raw text even when the model's own message paraphrase drops it, and \"الكل\" decides every pending request at once", t => {
  const db = fixture(t);
  const snapshot = getManagementSnapshot(db, owner);
  const ctx = text => ({ db, actor: owner, now: T0, text, users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: () => "T" });
  const base = { intakeMode: null, action: "reject", taskId: null, projectId: null, recipientIds: [], fields: { title: null, name: null, details: null, priority: null, dueDate: null, ownerId: null, reason: null, body: null, remindAt: null } };
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-10", reason: "المحكمة" }, { now: T0 });
  requestTaskOwnership(db, shadi, { taskId: "t2" }, { now: T0 + 1 });
  assert.equal(listApprovals(db, owner).length, 2);
  // The model paraphrased away the ordinal entirely -- without ctx.text this
  // used to fall straight into the ambiguous-candidates clarify.
  const decided = handleAgentIntent({ ...base, kind: "decide", message: "بدك ترفض الطلب المطلوب" }, ctx("ارفض الاول"));
  assert.equal(decided.status, "applied", `expected the raw text's ordinal to resolve the target, got: ${decided.reply}`);
  assert.match(decided.reply, /تمديد/, "must have picked the FIRST pending request (خالد's extension), not شادي's");
  assert.equal(listApprovals(db, owner, { status: "pending" }).length, 1);
  // "رفض رقم 1" (a bare digit, not a spelled-out ordinal) must resolve the
  // same way against the one request still pending.
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-12", reason: "تمديد ثاني" }, { now: T0 + 2 });
  assert.equal(listApprovals(db, owner, { status: "pending" }).length, 2);
  const byNumber = handleAgentIntent({ ...base, kind: "decide", message: "تم" }, ctx("رفض رقم 1"));
  assert.equal(byNumber.status, "applied");
  assert.equal(listApprovals(db, owner, { status: "pending" }).length, 1);
  // "ارفض الكل": every request still pending gets decided together instead of
  // repeating the same clarify or requiring one-at-a-time ordinals.
  requestTaskOwnership(db, shadi, { taskId: "t2" }, { now: T0 + 3 });
  assert.equal(listApprovals(db, owner, { status: "pending" }).length, 2);
  const all = handleAgentIntent({ ...base, kind: "decide", action: "reject", message: "خلص" }, ctx("ارفض الكل"));
  assert.equal(all.status, "applied");
  assert.match(all.reply, /رفضت 2 طلبات/);
  assert.equal(listApprovals(db, owner, { status: "pending" }).length, 0);
  // listApprovals defaults to status:"pending" when no filter is given, so the
  // full rejected count needs an explicit status filter here.
  assert.equal(listApprovals(db, owner, { status: "rejected" }).length, 4);
});

// Basim's actual complaint: his approvals come back green/red with nothing to
// tap, and once more than one is pending he can't tell which number is which
// request. The owner-listing ("approvals") and the ambiguous-multi-candidate
// "decide" clarify are the two places several pending requests land in one
// message -- both must now attach a real tap-to-decide poll (one ✅/❌ pair per
// request) instead of only the text-based ordinal instructions, but only in a
// conversation that can actually show a live poll (see AgentContext.conversationKey),
// and only up to the existing 12-option/6-approval cap.
test("approvals listing and the ambiguous-decide clarify attach a real tap-to-decide poll, bounded and gated on conversationKey", t => {
  const db = fixture(t);
  migrateSecretaryChoices(db);
  const snapshot = getManagementSnapshot(db, owner);
  const ctx = (actor, extra = {}) => ({ db, actor, now: T0, conversationKey: "basem-dm", users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: () => "T", ...extra });
  const inTx = work => { db.exec("BEGIN"); try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-10", reason: "المحكمة" }, { now: T0 });
  requestTaskOwnership(db, shadi, { taskId: "t2" }, { now: T0 + 1 });
  const base = { intakeMode: null, action: null, taskId: null, projectId: null, recipientIds: [], fields: { title: null, name: null, details: null, priority: null, dueDate: null, ownerId: null, reason: null, body: null, remindAt: null } };
  // Owner listing: one ✅/❌ pair per pending request, no number to pick.
  const list = inTx(() => handleAgentIntent({ ...base, kind: "approvals", message: null }, ctx(owner)));
  assert.ok(list.choices, "owner approvals listing must attach a real poll");
  assert.equal(list.choices.options.length, 4);
  assert.ok(list.choices.options.some(o => /تمديد/.test(o.label) && /✅/.test(o.label)));
  assert.ok(list.choices.options.some(o => /تمديد/.test(o.label) && /❌/.test(o.label)));
  assert.equal(peekSecretaryChoiceField(db, "basem-dm"), "approvalDecision");
  // Ambiguous "decide" (text matches neither an ordinal nor a specific
  // requester) must show the same kind of poll for its candidates -- this is
  // the exact "عندك خمس طلبات" scenario he described.
  const ambiguous = inTx(() => handleAgentIntent({ ...base, kind: "decide", action: "approve", message: "بدك تقرر إيش" }, ctx(owner, { text: "قرر" })));
  assert.equal(ambiguous.status, "clarify");
  assert.ok(ambiguous.choices, "ambiguous multi-candidate clarify must attach a real poll too");
  assert.equal(ambiguous.choices.options.length, 4);
  // An employee asking about their own requests never gets a decision poll
  // (they can't decide anything) -- plain text only, as before.
  const employeeView = inTx(() => handleAgentIntent({ ...base, kind: "approvals" }, ctx(khaled)));
  assert.equal(employeeView.choices, undefined);
  // No live-poll-capable conversation (e.g. a group reply) -- conversationKey
  // absent -- degrades to the existing text-only reply, never throws.
  const noKey = inTx(() => handleAgentIntent({ ...base, kind: "approvals" }, { ...ctx(owner), conversationKey: undefined }));
  assert.equal(noKey.choices, undefined);
  assert.match(noKey.reply, /بانتظار قرارك|طلب/);
  // Beyond the 12-option/6-approval cap, fall back to text-only rather than
  // failing createSecretaryChoices' own option-count guard. project_create
  // requests have no entity yet, so they can pile up freely (no dedup) --
  // a convenient way to pad the count past 6 without juggling ownership rules.
  for (let i = 0; i < 5; i++) requestProjectCreate(db, khaled, { name: `مشروع تجريبي ${i}` }, { now: T0 + 10 + i });
  assert.ok(listApprovals(db, owner, { status: "pending" }).length > 6);
  const tooMany = inTx(() => handleAgentIntent({ ...base, kind: "approvals" }, ctx(owner)));
  assert.equal(tooMany.choices, undefined);
});

test("project_draft parses task lines, previews for owner, and bundle creation is atomic + audited", t => {
  const db = fixture(t);
  const snapshot = getManagementSnapshot(db, owner);
  const parsed = parseProjectTaskLines("البضاعة | khaled | red | -\nاللوحة | شادي | yellow | 2026-09-20\nالاتصالات | ghost | green | -", snapshot.users);
  assert.equal(parsed.tasks.length, 3); assert.equal(parsed.tasks[1].ownerId, "shadi"); assert.equal(parsed.problems.length, 1);
  const plan = { kind: "project_draft", intakeMode: null, action: null, taskId: null, projectId: null, recipientIds: [], message: "البضاعة | khaled | red | -", fields: { title: null, name: "تجهيز دابوق", details: "افتتاح الفرع", priority: null, dueDate: null, ownerId: null, reason: null, body: null, remindAt: null } };
  const stashed = [];
  const preview = handleAgentIntent(plan, { db, actor: owner, now: T0, users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: command => { stashed.push(command); return "TXYZ"; } });
  assert.equal(preview.status, "confirmation"); assert.match(preview.reply, /ملخص المشروع قبل الإنشاء/);
  assert.equal(stashed[0].action, "create_project_bundle");
  const result = createProjectBundle(db, owner, stashed[0], T0 + 5, { origin: "test" });
  assert.match(result.reply, /مع مهمة واحدة/);
  assert.equal(result.projectId, db.prepare("SELECT id FROM projects WHERE name='تجهيز دابوق'").get().id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=(SELECT id FROM projects WHERE name='تجهيز دابوق')").get().n, 1);
  // A plain member may also propose a project now (approval.request, which every
  // role has) -- it is filed for Basim's decision, never created directly.
  const filed = handleAgentIntent(plan, { db, actor: khaled, now: T0, users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: () => "T" });
  assert.equal(filed.status, "applied");
  assert.match(filed.reply, /رفعت اقتراح المشروع/);
});

test("follow-ups: overdue owner nudge once per day, stale approval to owner, digest bounded; queued notifications first", async t => {
  const db = fixture(t);
  const at = Date.UTC(2026, 8, 10, 7, 0); // 10:00 Amman, Thursday
  const config = { enabled: true, contacts: [{ userId: "basem", number: "966500000000" }, { userId: "khaled", number: "962770000000" }], groupId: "123@g.us" };
  let plans = planFollowups(db, config, at);
  assert.deepEqual(plans.map(plan => plan.kind).sort(), ["daily_digest", "overdue_task"]);
  assert.equal(plans.find(plan => plan.kind === "overdue_task").to, "962770000000@s.whatsapp.net");
  assert.equal(planFollowups(db, { ...config }, Date.UTC(2026, 8, 10, 20, 0)).length, 0, "outside working hours");
  const sent = [];
  const jobs = createFollowupJobs({ db, config, now: () => at });
  assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "sent");
  assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "sent");
  assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "idle", "no duplicates within a day");
  assert.equal(sent.length, 2);
  requestDeadlineExtension(db, khaled, { taskId: "t1", newDueDate: "2026-09-12", reason: "x" }, { now: at - 3 * 86_400_000 });
  enqueueAgentMessage(db, { toUser: "basem", text: "إشعار مباشر" }, at);
  const later = createFollowupJobs({ db, config, now: () => at + 60_000 });
  await later.deliverNext(async message => { sent.push(message); });
  assert.equal(sent[2].text, "إشعار مباشر", "queued notification is delivered before planned nudges");
  await later.deliverNext(async message => { sent.push(message); });
  assert.match(sent[3].text, /معلّقة من أكثر من يومين/);
  assert.ok(groupBudgetRemaining(db, at + 60_000) < GROUP_DAILY_BUDGET);
  assert.ok(isGroupWorthy("create", "project") && !isGroupWorthy("comment", "task"));
});

test("unclaimed task: hourly nudge to its suggested owner during work hours, stopping once they respond", async t => {
  const db = fixture(t);
  // t2 (open, no suggested_owner) must never nudge -- nobody is responsible yet.
  db.exec(`INSERT INTO tasks (id,project_id,title,status,owner,suggested_owner,due_date,created_at,updated_at)
    VALUES ('t6','p','تجديد الرخصة','open',NULL,'شادي',NULL,100,100)`);
  const config = { enabled: true, contacts: [{ userId: "basem", number: "966500000000" }, { userId: "khaled", number: "962770000000" }, { userId: "shadi", number: "962780000000" }], groupId: "123@g.us" };
  const at = Date.UTC(2026, 8, 10, 7, 0); // 10:00 Amman, inside the 9-18 work-hours window

  const plans = planFollowups(db, config, at).filter(plan => plan.kind === "unclaimed_task");
  assert.equal(plans.length, 1, "t2 has no suggested owner and never nudges");
  assert.equal(plans[0].targetUser, "shadi");
  assert.equal(plans[0].to, "962780000000@s.whatsapp.net");
  assert.match(plans[0].text, /تجديد الرخصة/);
  assert.match(plans[0].text, /استلمت/);

  assert.equal(planFollowups(db, config, Date.UTC(2026, 8, 10, 20, 0)).filter(plan => plan.kind === "unclaimed_task").length, 0, "outside working hours");

  // Once delivered, no duplicate within the same hour -- but it fires again an hour later if still unclaimed.
  db.prepare("INSERT INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES ('nudge1','unclaimed_task','shadi','t6',?,'sent')").run(at);
  assert.equal(planFollowups(db, config, at + 30 * 60_000).filter(plan => plan.kind === "unclaimed_task").length, 0, "no duplicate within the same hour");
  assert.equal(planFollowups(db, config, at + 60 * 60_000 + 1000).filter(plan => plan.kind === "unclaimed_task").length, 1, "fires again once the hour has passed");

  // Declining it moves the decision to Basim -- the employee already
  // responded, so the hourly nag must stop even though the task itself
  // stays "open" until Basim decides.
  requestTaskTransfer(db, shadi, { taskId: "t6", reason: "مش مسؤوليتي" }, { now: at + 2 * 60 * 60_000 });
  assert.equal(planFollowups(db, config, at + 3 * 60 * 60_000).filter(plan => plan.kind === "unclaimed_task").length, 0, "stops once the employee has responded, pending Basim's decision");
});

test("unclaimed task nudge stops as soon as the task is claimed", t => {
  const db = fixture(t);
  db.exec(`INSERT INTO tasks (id,project_id,title,status,owner,suggested_owner,due_date,created_at,updated_at)
    VALUES ('t7','p','جرد المستودع','open',NULL,'شادي',NULL,100,100)`);
  const config = { enabled: true, contacts: [{ userId: "basem", number: "966500000000" }, { userId: "shadi", number: "962780000000" }], groupId: "123@g.us" };
  const at = Date.UTC(2026, 8, 10, 7, 0);
  assert.equal(planFollowups(db, config, at).filter(plan => plan.kind === "unclaimed_task").length, 1);
  executeManagementAction(db, shadi, { action: "claim", taskId: "t7" }, { now: at + 1000 });
  assert.equal(planFollowups(db, config, at + 60 * 60_000 + 1000).filter(plan => plan.kind === "unclaimed_task").length, 0, "claimed tasks never nudge again");
});

test("twice-daily auto reminder fires at local 8am/8pm regardless of work hours, once per owner per slot, private + one group post each", async t => {
  const db = fixture(t);
  // t3 is only suggested (never claimed) -- still belongs on شادي's reminder,
  // same "who is responsible" convention as the on-demand broadcast.
  // t4 is completed and t5 archived: neither should ever appear.
  db.exec(`INSERT INTO tasks (id,project_id,title,status,owner,suggested_owner,due_date,created_at,updated_at,started_at,completed_at,archived_at)
    VALUES ('t3','p','دراسة الموقع','open',NULL,'شادي',NULL,100,100,NULL,NULL,NULL),
           ('t4','p','مهمة مكتملة','completed','خالد',NULL,NULL,100,100,100,100,NULL),
           ('t5','p','مهمة مؤرشفة','progress','خالد',NULL,NULL,100,100,100,NULL,100)`);
  const config = { enabled: true, contacts: [{ userId: "basem", number: "966500000000" }, { userId: "khaled", number: "962770000000" }, { userId: "shadi", number: "962780000000" }], groupId: "123@g.us" };
  const morning = Date.UTC(2026, 8, 10, 5, 0); // 08:00 Amman
  const evening = Date.UTC(2026, 8, 10, 17, 0); // 20:00 Amman
  const other = Date.UTC(2026, 8, 10, 7, 0); // 10:00 Amman -- no slot

  let plans = planFollowups(db, config, morning);
  const auto = plans.filter(plan => plan.kind === "auto_reminder_morning");
  assert.equal(auto.length, 4, "private + group post for خالد, private + group post for شادي");
  const privateKhaled = auto.find(plan => plan.targetUser === "khaled");
  assert.match(privateKhaled.text, /متابعة عقد الإيجار/);
  assert.doesNotMatch(privateKhaled.text, /مهمة مكتملة|مهمة مؤرشفة/);
  const groupKhaled = auto.find(plan => plan.targetUser === "group" && plan.entityId === "khaled");
  assert.match(groupKhaled.text, /🔴 \*خالد\*/); assert.match(groupKhaled.text, /متابعة عقد الإيجار/); assert.doesNotMatch(groupKhaled.text, /دراسة الموقع/);
  const groupShadi = auto.find(plan => plan.targetUser === "group" && plan.entityId === "shadi");
  assert.match(groupShadi.text, /🔴 \*شادي\*/); assert.match(groupShadi.text, /دراسة الموقع/); assert.doesNotMatch(groupShadi.text, /متابعة عقد الإيجار/);
  assert.equal(plans.filter(plan => plan.kind !== "auto_reminder_morning").length, 0, "outside 9-18 window, no reactive follow-ups mixed in");
  assert.equal(planFollowups(db, config, other).filter(plan => plan.kind.startsWith("auto_reminder")).length, 0, "no auto reminder outside the 8am/8pm slots");

  // planFollowups is pure (it only reads); the dedup only takes effect once
  // a plan is actually recorded via deliverNext, exactly like overdue_task.
  const sent = [];
  const jobs = createFollowupJobs({ db, config, now: () => morning });
  for (let i = 0; i < 4; i++) assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "sent");
  assert.equal((await jobs.deliverNext(async () => assert.fail("no fifth message this slot"))).status, "idle");
  assert.equal(sent.length, 4);

  assert.equal(planFollowups(db, config, morning + 5 * 60_000).filter(plan => plan.kind === "auto_reminder_morning").length, 0, "no duplicate within the same morning slot once delivered");

  const eveningPlans = planFollowups(db, config, evening).filter(plan => plan.kind === "auto_reminder_evening");
  assert.equal(eveningPlans.length, 4, "evening slot is independent of the morning dedup");
});

