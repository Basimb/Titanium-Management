import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { executeManagementAction, getManagementSnapshot, migrateManagementActions, ManagementActionError } from "../lib/management-actions.ts";
import { decideApproval, findPendingApproval, listApprovals, requestDeadlineExtension, requestProjectCreate, requestTaskClose, staleApprovals } from "../lib/approvals.ts";
import { can, capabilities, inScope } from "../lib/permissions.ts";
import { activeRules, policyViolations, proposeRuleFromStatement, recordCorrection, suggestOwner, CORRECTION_THRESHOLD } from "../lib/rules.ts";
import { addKnowledge, searchKnowledge } from "../lib/knowledge.ts";
import { createFollowupJobs, enqueueAgentMessage, planFollowups } from "../lib/agent-followups.ts";
import { handleAgentIntent, parseProjectTaskLines, createProjectBundle } from "../lib/secretary-agent.ts";
import { groupBudgetRemaining, isGroupWorthy } from "../lib/team-chat-policy.ts";

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
  assert.match(result.reply, /مع 1 مهام/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=(SELECT id FROM projects WHERE name='تجهيز دابوق')").get().n, 1);
  const denied = handleAgentIntent(plan, { db, actor: khaled, now: T0, users: snapshot.users, tasks: snapshot.tasks, projects: snapshot.projects, stash: () => "T" });
  assert.equal(denied.status, "denied");
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
  assert.ok(groupBudgetRemaining(db, at + 60_000) < 12);
  assert.ok(isGroupWorthy("create", "project") && !isGroupWorthy("comment", "task"));
});

