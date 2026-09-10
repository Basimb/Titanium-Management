import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeManagementAction, getManagementSnapshot, ManagementActionError, migrateManagementActions, resolveManagementActor, type ManagementActor, type ManagementResult, type ManagementTask } from "./management-actions.ts";
import { can, isOwner, type PermissionActor } from "./permissions.ts";
import type { SecretaryChoices } from "./secretary-choices.ts";

export type ApprovalType = "deadline_extension" | "priority_change" | "task_close" | "task_ownership" | "task_transfer" | "task_create" | "project_create" | "project_close" | "rule" | "policy";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type Approval = {
  id: string; type: ApprovalType; status: ApprovalStatus; requestedBy: string; requestedByName: string;
  entityType: "task" | "project" | "rule"; entityId: string | null; summary: string; payload: Record<string, unknown>;
  decidedBy: string | null; decisionNote: string | null; createdAt: number; decidedAt: number | null; lastNudgedAt: number | null;
};
export type ApprovalDecision = { approval: Approval; effect: ManagementResult | null; notifyRequester: string; notifyGroup: string | null; notifyExtra: Array<{ userId: string; text: string }> };

export class ApprovalError extends ManagementActionError {}
const fail = (status: number, code: string, message: string): never => { throw new ApprovalError(status, code, message); };
const SELECT = "SELECT id,type,status,requested_by AS requestedBy,requested_by_name AS requestedByName,entity_type AS entityType,entity_id AS entityId,summary,payload,decided_by AS decidedBy,decision_note AS decisionNote,created_at AS createdAt,decided_at AS decidedAt,last_nudged_at AS lastNudgedAt FROM approvals";
const TYPE_LABEL: Record<ApprovalType, string> = { deadline_extension: "تمديد موعد", priority_change: "تعديل أولوية", task_close: "اعتماد إغلاق مهمة", task_ownership: "طلب مسؤولية مهمة", task_transfer: "طلب تحويل مهمة", task_create: "فتح مهمة", project_create: "فتح مشروع", project_close: "اعتماد إغلاق مشروع", rule: "اعتماد قاعدة", policy: "اعتماد سياسة" };
const PRIORITY_ARABIC: Record<string, string> = { red: "🔴 عاجلة", yellow: "🟡 متوسطة", green: "🟢 عادية" };
export const APPROVAL_TTL_MS = 14 * 24 * 60 * 60_000;
// Every approval request DM ends with this same explicit 🟢/🔴 choice, so
// whether Basim is looking at a single request the moment it's filed or
// several at once via formatPendingList/the ambiguous-candidates clarify
// above, "how do I answer this" always looks and reads the same way.
const APPROVAL_CHOICE_HINT = "\n\n🟢 اعتماد: اكتب «اعتمد»\n🔴 رفض: اكتب «ارفض»";
// Mirrors the same 🟢/🔴 choice APPROVAL_CHOICE_HINT spells out in words as a
// real tappable WhatsApp poll, so a proactive approval notification -- filed
// from an employee's own conversation, landing in Basim's chat outside any
// live turn of his -- can be answered with one tap instead of typing "اعتمد"/
// "ارفض". The poll's own option ids carry the approval id, so a tap resolves
// deterministically (see parseApprovalPollChoice in secretary-service.ts)
// with no ambiguity step even when several requests are pending at once.
// WhatsApp polls expire after at most an hour; APPROVAL_CHOICE_HINT's text
// instructions in the same message keep working after that, or if the poll
// is missed/dismissed.
function approvalDecisionPoll(approval: Approval, at: number): SecretaryChoices {
  return { id: `APR${approval.id}`, title: "قرارك على الطلب؟", expiresAt: at + 60 * 60_000,
    options: [{ id: `APR${approval.id}Y`, label: "🟢 اعتماد" }, { id: `APR${approval.id}N`, label: "🔴 رفض" }] };
}

function hydrate(row: Record<string, unknown>): Approval {
  let payload: Record<string, unknown> = {};
  try { const parsed = JSON.parse(String(row.payload)); if (parsed && typeof parsed === "object") payload = parsed; } catch { /* keep empty */ }
  return { ...(row as unknown as Approval), payload };
}
function dateOnly(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return fail(400, "invalid_date", `${label} يجب أن يكون تاريخًا صحيحًا`);
  return value;
}
function text(value: unknown, label: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) return fail(400, "invalid_text", `${label} مطلوب وبحد أقصى ${max} حرفًا`);
  return value.trim();
}
function now(options?: { now?: number }) { return options?.now ?? Date.now(); }
// Arabic count agreement for "مهمة" -- 1 and 2 have their own words, 3-10 take
// the plural, 11+ reverts to the singular after the number.
const taskCountPhrase = (n: number) => n === 1 ? "مهمة واحدة" : n === 2 ? "مهمتين" : n <= 10 ? `${n} مهام` : `${n} مهمة`;

export function listApprovals(db: DatabaseSync, claimed: ManagementActor, filter: { status?: ApprovalStatus; limit?: number } = {}): Approval[] {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const status = filter.status ?? "pending";
  const rows = db.prepare(`${SELECT} WHERE status=? ORDER BY created_at ASC LIMIT ?`).all(status, Math.min(filter.limit ?? 50, 200)) as Record<string, unknown>[];
  return rows.map(hydrate).filter(approval => isOwner(actor as PermissionActor) || approval.requestedBy === actor.id);
}

export function getApproval(db: DatabaseSync, claimed: ManagementActor, id: string): Approval {
  const found = listApprovals(db, claimed, { status: "pending", limit: 200 }).find(approval => approval.id === id)
    ?? (isOwner(resolveManagementActor(db, claimed) as PermissionActor) ? (db.prepare(`${SELECT} WHERE id=?`).get(id) as Record<string, unknown> | undefined) : undefined);
  if (!found) return fail(404, "approval_missing", "الطلب غير موجود أو غير متاح لك");
  return "payload" in found && typeof found.payload === "object" ? found as Approval : hydrate(found as Record<string, unknown>);
}

function insert(db: DatabaseSync, actor: ManagementActor, input: { type: ApprovalType; entityType: Approval["entityType"]; entityId: string | null; summary: string; payload: Record<string, unknown> }, at: number): Approval {
  if (!can(actor as PermissionActor, "approval.request")) return fail(403, "not_allowed", "لا تملك صلاحية إرسال طلبات");
  const duplicate = input.entityId ? db.prepare("SELECT id FROM approvals WHERE status='pending' AND type=? AND entity_id=?").get(input.type, input.entityId) : undefined;
  if (duplicate) return fail(409, "approval_exists", "يوجد طلب مماثل بانتظار القرار بالفعل");
  const id = randomUUID();
  db.prepare("INSERT INTO approvals (id,type,status,requested_by,requested_by_name,entity_type,entity_id,summary,payload,created_at) VALUES (?,?,'pending',?,?,?,?,?,?,?)")
    .run(id, input.type, actor.id, actor.name, input.entityType, input.entityId, input.summary.slice(0, 500), JSON.stringify(input.payload), at);
  db.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(actor.id, actor.name, "request_approval", input.entityType, input.entityId ?? id, JSON.stringify({ summary: input.summary, source: "approval", approvalId: id, type: input.type }), at);
  return hydrate(db.prepare(`${SELECT} WHERE id=?`).get(id) as Record<string, unknown>);
}

function visibleTask(db: DatabaseSync, actor: ManagementActor, taskId: string): ManagementTask {
  const snapshot = getManagementSnapshot(db, actor);
  const task = snapshot.tasks.find(candidate => candidate.id === taskId);
  if (!task || task.archivedAt !== null) return fail(404, "task_missing", "المهمة غير موجودة أو غير متاحة لك");
  return task;
}
// Unscoped on purpose: proposing a brand-new task in a project doesn't require
// the requester to already have a visible task there (getManagementSnapshot's
// project list is scoped to projects the actor already has a task in), only
// that the project itself exists and is open for work.
function activeProject(db: DatabaseSync, projectId: string): { id: string; name: string } {
  const project = db.prepare("SELECT id,name,status,archived_at AS archivedAt FROM projects WHERE id=?").get(projectId) as
    { id: string; name: string; status: string; archivedAt: number | null } | undefined;
  if (!project || project.status !== "active" || project.archivedAt !== null) return fail(404, "project_missing", "المشروع غير موجود أو غير نشط");
  return { id: project.id, name: project.name };
}

/** Employee asks for more time. Nothing changes on the task until the owner decides. */
export function requestDeadlineExtension(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; newDueDate: string; reason: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const task = visibleTask(db, actor, input.taskId);
  if (!isOwner(actor as PermissionActor) && task.owner !== actor.name) return fail(403, "not_owned", "التمديد متاح للمسؤول عن المهمة فقط");
  if (task.status === "completed") return fail(409, "invalid_transition", "المهمة مكتملة بالفعل");
  const newDueDate = dateOnly(input.newDueDate, "الموعد المقترح");
  if (task.dueDate && newDueDate <= task.dueDate) return fail(400, "not_extension", "الموعد المقترح يجب أن يكون بعد الموعد الحالي");
  const reason = text(input.reason, "سبب التمديد", 1000);
  const summary = `تمديد «${task.title}» من ${task.dueDate ?? "بدون موعد"} إلى ${newDueDate}`;
  const at = now(options);
  const approval = insert(db, actor, { type: "deadline_extension", entityType: "task", entityId: task.id, summary, payload: { oldDueDate: task.dueDate, newDueDate, reason, taskTitle: task.title, expectedUpdatedAt: task.updatedAt } }, at);
  const ownerMessage = `${actor.name} طلب تمديد مهمة «${task.title}»\nالموعد السابق: ${task.dueDate ?? "غير محدد"}\nالموعد المقترح: ${newDueDate}\nالسبب: ${reason}${APPROVAL_CHOICE_HINT}`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Employee/manager asks to change a task's priority. Same trust model as
 * requestDeadlineExtension -- nothing changes on the task until Basim decides,
 * even for a manager who otherwise has the task.edit capability, since
 * priority_change (like extension) is deliberately routed through this
 * request path for everyone except Basim (see the "owner" check in
 * secretary-agent.ts's priority_change case). */
export function requestPriorityChange(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; newPriority: "red" | "yellow" | "green"; reason?: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const task = visibleTask(db, actor, input.taskId);
  if (!isOwner(actor as PermissionActor) && task.owner !== actor.name) return fail(403, "not_owned", "تعديل الأولوية متاح للمسؤول عن المهمة فقط");
  if (task.status === "completed") return fail(409, "invalid_transition", "المهمة مكتملة بالفعل");
  if (task.priority === input.newPriority) return fail(400, "not_a_change", "هذي أصلًا أولوية المهمة الحالية");
  const reason = text(input.reason, "سبب تعديل الأولوية", 1000, true);
  const summary = `تعديل أولوية «${task.title}» من ${PRIORITY_ARABIC[task.priority]} إلى ${PRIORITY_ARABIC[input.newPriority]}`;
  const at = now(options);
  const approval = insert(db, actor, { type: "priority_change", entityType: "task", entityId: task.id, summary, payload: { oldPriority: task.priority, newPriority: input.newPriority, reason, taskTitle: task.title, expectedUpdatedAt: task.updatedAt } }, at);
  const ownerMessage = `${actor.name} طلب تعديل أولوية مهمة «${task.title}»\nمن: ${PRIORITY_ARABIC[task.priority]}\nإلى: ${PRIORITY_ARABIC[input.newPriority]}${reason ? `\nالسبب: ${reason}` : ""}${APPROVAL_CHOICE_HINT}`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Employee says the work is done. Task moves to approval (existing submit) and a durable request is filed. */
export function requestTaskClose(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; result: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; effect: ManagementResult; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const task = visibleTask(db, actor, input.taskId);
  const result = text(input.result, "نتيجة التنفيذ", 4000);
  const at = now(options);
  if (task.status === "progress") executeManagementAction(db, actor, { action: "comment", taskId: task.id, comment: `نتيجة التنفيذ: ${result}` }, { now: at, source: "approval" });
  const effect = task.status === "approval" ? null : executeManagementAction(db, actor, { action: "submit", taskId: task.id }, { now: at, source: "approval" });
  const summary = `إغلاق «${task.title}»`;
  const approval = insert(db, actor, { type: "task_close", entityType: "task", entityId: task.id, summary, payload: { result, taskTitle: task.title } }, at);
  const ownerMessage = `${actor.name} يقول إن مهمة «${task.title}» انتهت.\nالنتيجة: ${result}${APPROVAL_CHOICE_HINT}\n(لو رفضت، اذكر السبب)`;
  return { approval, ownerMessage, effect: effect ?? { ok: true, action: "submit", entityType: "task", entityId: task.id, message: "المهمة بانتظار الاعتماد", deletedObjectKeys: [] }, choices: approvalDecisionPoll(approval, at) };
}

/** Employee requests responsibility for an active task; assignment changes only after Basim approves. */
export function requestTaskOwnership(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; reason?: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (isOwner(actor as PermissionActor)) return fail(400, "employee_only", "طلب مسؤولية المهمة مخصص للموظفين");
  const task = db.prepare("SELECT id,title,status,owner,suggested_owner AS suggestedOwner,updated_at AS updatedAt,archived_at AS archivedAt FROM tasks WHERE id=?").get(input.taskId) as { id: string; title: string; status: string; owner: string | null; suggestedOwner: string | null; updatedAt: number; archivedAt: number | null } | undefined;
  if (!task || task.archivedAt !== null) return fail(404, "task_missing", "المهمة غير موجودة أو مؤرشفة");
  if (task.status === "completed" || task.status === "approval") return fail(409, "invalid_transition", "المهمة منتهية أو بانتظار الاعتماد");
  if (task.owner === actor.name || task.suggestedOwner === actor.name) return fail(409, "already_assigned", "المهمة معيّنة لك؛ قل «استلم المهمة» لبدء التنفيذ");
  const reason = text(input.reason, "سبب الطلب", 1000, true);
  const summary = `${actor.name} يطلب مسؤولية «${task.title}»`;
  const at = now(options);
  const approval = insert(db, actor, { type: "task_ownership", entityType: "task", entityId: task.id, summary, payload: { taskTitle: task.title, requestedOwnerId: actor.id, requestedOwnerName: actor.name, previousOwner: task.owner, previousSuggestedOwner: task.suggestedOwner, expectedUpdatedAt: task.updatedAt, reason } }, at);
  return { approval, ownerMessage: `${summary}${task.owner || task.suggestedOwner ? `\nالمسؤول الحالي: ${task.owner || task.suggestedOwner}` : "\nالمهمة غير معيّنة حاليًا"}${reason ? `\nالسبب: ${reason}` : ""}${APPROVAL_CHOICE_HINT}`, choices: approvalDecisionPoll(approval, at) };
}

/** Employee holding a task hands it to a named colleague, or declines it outright
 * (no colleague named -- "مش مسؤوليتي"). Nothing changes on the task until Basim
 * decides; a decline with no suggested colleague simply clears the assignment. */
export function requestTaskTransfer(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; suggestedOwnerId?: string | null; reason?: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (isOwner(actor as PermissionActor)) return fail(400, "employee_only", "أنت تقدر تعيد تعيين المهمة مباشرة");
  const task = visibleTask(db, actor, input.taskId);
  if (task.owner !== actor.name && task.suggestedOwner !== actor.name) return fail(403, "not_owned", "تحويل المهمة متاح للمسؤول عنها فقط");
  if (task.status === "completed" || task.status === "approval") return fail(409, "invalid_transition", "المهمة منتهية أو بانتظار الاعتماد");
  // A plain user-existence/name lookup, never the actor's own visibility-scoped
  // snapshot -- getManagementSnapshot restricts a member's users list to just
  // themselves, which would wrongly hide the very colleague they are naming here.
  const suggestedOwnerId = input.suggestedOwnerId || null;
  const suggestedOwnerName = suggestedOwnerId ? (db.prepare("SELECT name FROM users WHERE id=? AND active=1").get(suggestedOwnerId) as { name: string } | undefined)?.name ?? null : null;
  if (suggestedOwnerId && !suggestedOwnerName) return fail(400, "owner_missing", "الموظف المقترح غير موجود أو غير مفعّل");
  if (suggestedOwnerId === actor.id) return fail(400, "self_transfer", "هاي مهمتك أصلًا؛ اذكر اسم الزميل الذي تريد تحويلها له");
  const reason = text(input.reason, "سبب التحويل", 1000, true);
  const summary = suggestedOwnerName ? `تحويل «${task.title}» من ${actor.name} إلى ${suggestedOwnerName}` : `${actor.name} يعتذر عن «${task.title}» (مش مسؤوليته)`;
  const at = now(options);
  const approval = insert(db, actor, { type: "task_transfer", entityType: "task", entityId: task.id,
    summary, payload: { taskTitle: task.title, fromOwnerId: actor.id, fromOwnerName: actor.name, suggestedOwnerId, suggestedOwnerName, reason, expectedUpdatedAt: task.updatedAt } }, at);
  const ownerMessage = suggestedOwnerName
    ? `${actor.name} بده يحوّل مهمة «${task.title}» إلى ${suggestedOwnerName}${reason ? `\nالسبب: ${reason}` : ""}${APPROVAL_CHOICE_HINT}`
    : `${actor.name} يقول إن مهمة «${task.title}» مش مسؤوليته${reason ? `\nالسبب: ${reason}` : ""}\nاعتماد الطلب بيشيلها عنه بانتظار تعيين مسؤول جديد.${APPROVAL_CHOICE_HINT}`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Manager (or employee) asks to close/archive a whole project. Nothing changes
 * until Basim decides -- see project.archive moving to OWNER_ONLY in permissions.ts. */
export function requestProjectClose(db: DatabaseSync, claimed: ManagementActor, input: { projectId: string; reason?: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (isOwner(actor as PermissionActor)) return fail(400, "employee_only", "أنت تقدر تغلق المشروع مباشرة");
  const project = db.prepare("SELECT id,name,status,archived_at AS archivedAt FROM projects WHERE id=?").get(input.projectId) as
    { id: string; name: string; status: string; archivedAt: number | null } | undefined;
  if (!project || project.archivedAt !== null) return fail(404, "project_missing", "المشروع غير موجود أو مؤرشف بالفعل");
  const reason = text(input.reason, "سبب الإغلاق", 1000, true);
  // Archiving never blocks on open tasks (Basim can already do it directly),
  // but he's now the one deciding requests he didn't initiate himself -- he
  // needs to know what's still open before approving blind.
  const openTasks = (db.prepare("SELECT count(*) AS n FROM tasks WHERE project_id=? AND archived_at IS NULL AND status!='completed'").get(project.id) as { n: number }).n;
  const summary = `إغلاق مشروع «${project.name}»`;
  const at = now(options);
  const approval = insert(db, actor, { type: "project_close", entityType: "project", entityId: project.id, summary, payload: { projectName: project.name, reason, openTasks } }, at);
  const ownerMessage = `${actor.name} يطلب إغلاق مشروع «${project.name}»${reason ? `\nالسبب: ${reason}` : ""}${openTasks ? `\n⚠️ لسا فيه ${taskCountPhrase(openTasks)} مفتوحة بالمشروع.` : "\nكل مهام المشروع منتهية."}${APPROVAL_CHOICE_HINT}`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Manager/employee proposes a project. Created as pending and filed as a request. */
export function requestProjectCreate(db: DatabaseSync, claimed: ManagementActor, input: { name: string; goal?: string; tasks?: Array<{ title: string; ownerId?: string | null; priority?: "red" | "yellow" | "green"; dueDate?: string | null }> }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const name = text(input.name, "اسم المشروع", 240);
  const goal = text(input.goal, "الهدف", 2000, true);
  const tasks = (input.tasks ?? []).slice(0, 40).map(task => ({ title: text(task.title, "اسم المهمة", 240), ownerId: task.ownerId ?? null, priority: task.priority ?? "yellow", dueDate: task.dueDate ?? null }));
  const summary = `فتح مشروع «${name}»${tasks.length ? ` مع ${taskCountPhrase(tasks.length)}` : ""}`;
  const at = now(options);
  const approval = insert(db, actor, { type: "project_create", entityType: "project", entityId: null, summary, payload: { name, goal, tasks } }, at);
  const lines = tasks.map((task, index) => `${index + 1}. ${task.title}${task.ownerId ? ` — ${task.ownerId}` : ""} — ${task.priority}${task.dueDate ? ` — ${task.dueDate}` : ""}`);
  const ownerMessage = `${actor.name} يقترح فتح مشروع «${name}»${goal ? `\nالهدف: ${goal}` : ""}${lines.length ? `\nالمهام:\n${lines.join("\n")}` : ""}${APPROVAL_CHOICE_HINT}`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Employee (or a manager, who may also create tasks directly -- see can(actor,"task.create"))
 * proposes a single task. Filed as pending; nothing exists until Basim decides.
 * Basim may correct priority/dueDate in the same message he decides -- see
 * patchTaskCreateApproval, applied by the "decide" agent case before deciding. */
export function requestTaskCreate(db: DatabaseSync, claimed: ManagementActor, input: { projectId: string; title: string; details?: string; priority: "red" | "yellow" | "green"; dueDate: string | null; ownerId?: string | null }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const snapshot = getManagementSnapshot(db, actor);
  const project = activeProject(db, input.projectId);
  const title = text(input.title, "اسم المهمة", 240);
  const details = text(input.details, "التفاصيل", 10_000, true);
  if (!["red", "yellow", "green"].includes(input.priority)) return fail(400, "invalid_priority", "حدد أولوية المهمة");
  const dueDate = input.dueDate ? dateOnly(input.dueDate, "الموعد") : null;
  const ownerId = input.ownerId ?? actor.id;
  const ownerName = snapshot.users.find(user => user.id === ownerId && user.active === 1)?.name ?? actor.name;
  // Basim never sees which project a task landed under (see secretary-service.ts's
  // display sweep) -- summary/ownerMessage stay project-free even though the
  // task still needs a real projectId under the hood (payload.projectName is
  // kept only for internal bookkeeping, never rendered to him).
  const summary = `فتح مهمة «${title}»`;
  const at = now(options);
  const approval = insert(db, actor, { type: "task_create", entityType: "task", entityId: null, summary,
    payload: { projectId: project.id, projectName: project.name, title, details, priority: input.priority, dueDate, ownerId, ownerName } }, at);
  const ownerMessage = `${actor.name} يقترح فتح مهمة «${title}»${details ? `\nالتفاصيل: ${details}` : ""}\nالمسؤول: ${ownerName}\nالأولوية: ${PRIORITY_ARABIC[input.priority]}\nالموعد: ${dueDate ?? "بدون موعد"}${APPROVAL_CHOICE_HINT}\n(تقدر كمان تصحح قبل ما توافق، مثلاً: «اعتمد بس خلها حمراء ومدتها يومين»)`;
  return { approval, ownerMessage, choices: approvalDecisionPoll(approval, at) };
}

/** Basim corrects priority/dueDate on a still-pending task_create request, normally
 * in the same message as his decision ("اعتمد بس خلها حمراء"). Returns the patched
 * approval; the caller decides it (or not) right after. Never touches anything else
 * -- the requester, project and title stay exactly as proposed. */
export function patchTaskCreateApproval(db: DatabaseSync, claimed: ManagementActor, input: { approvalId: string; priority?: "red" | "yellow" | "green"; dueDate?: string | null }, options: { now?: number } = {}): Approval {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "approval.decide")) return fail(403, "admin_required", "تعديل الطلبات لباسم فقط");
  const approval = getApproval(db, actor, input.approvalId);
  if (approval.type !== "task_create") return fail(400, "not_task_create", "التعديل قبل الاعتماد متاح لطلبات فتح المهمة فقط حاليًا");
  if (approval.status !== "pending") return fail(409, "already_decided", "هذا الطلب حُسم سابقًا");
  const payload = { ...approval.payload };
  if (input.priority) payload.priority = input.priority;
  if (input.dueDate !== undefined) payload.dueDate = input.dueDate ? dateOnly(input.dueDate, "الموعد") : null;
  const at = now(options);
  db.prepare("UPDATE approvals SET payload=? WHERE id=?").run(JSON.stringify(payload), approval.id);
  db.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(actor.id, actor.name, "edit_approval", approval.entityType, approval.id, JSON.stringify({ summary: `عدّل طلب فتح مهمة قبل الاعتماد`, source: "approval", approvalId: approval.id, patch: input }), at);
  return hydrate(db.prepare(`${SELECT} WHERE id=?`).get(approval.id) as Record<string, unknown>);
}

/** A rule/policy proposal (from a correction pattern or an explicit statement). Like every
 * other approval-request function here, this attaches a real tappable 🟢/🔴 poll -- a rule
 * proposal is a decision Basim needs to act on exactly like a deadline extension or a task
 * transfer, and it shouldn't be the one request type that makes him type "اعتمد" by hand. */
export function requestRule(db: DatabaseSync, claimed: ManagementActor, input: { kind: "assignment" | "policy" | "note"; statement: string; match?: Record<string, unknown>; effect?: Record<string, unknown> }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; choices: SecretaryChoices } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const statement = text(input.statement, "نص القاعدة", 1000);
  const at = now(options);
  const approval = insert(db, actor, { type: input.kind === "policy" ? "policy" : "rule", entityType: "rule", entityId: null, summary: statement, payload: { kind: input.kind, statement, match: input.match ?? {}, effect: input.effect ?? {} } }, at);
  return { approval, ownerMessage: `اقتراح قاعدة:\n${statement}${APPROVAL_CHOICE_HINT}`, choices: approvalDecisionPoll(approval, at) };
}

/** Owner decides. The effect is applied through the same audited action engine. */
export function decideApproval(db: DatabaseSync, claimed: ManagementActor, input: { approvalId: string; decision: "approved" | "rejected"; note?: string }, options: { now?: number } = {}): ApprovalDecision {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "approval.decide")) return fail(403, "admin_required", "القرار على الطلبات لباسم فقط");
  const approval = getApproval(db, actor, input.approvalId);
  if (approval.status !== "pending") return fail(409, "already_decided", "هذا الطلب حُسم سابقًا");
  const note = text(input.note, "الملاحظة", 2000, true);
  const at = now(options);
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT approval_decision" : "BEGIN IMMEDIATE");
  try {
    let effect: ManagementResult | null = null;
    let notifyGroup: string | null = null;
    if (input.decision === "approved") {
      switch (approval.type) {
        case "deadline_extension": {
          effect = executeManagementAction(db, actor, { action: "edit_task", taskId: approval.entityId!, dueDate: String(approval.payload.newDueDate) }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          notifyGroup = `📅 مُدّد موعد مهمة «${approval.payload.taskTitle}» إلى ${approval.payload.newDueDate}`;
          break;
        }
        case "priority_change": {
          effect = executeManagementAction(db, actor, { action: "edit_task", taskId: approval.entityId!, priority: approval.payload.newPriority as "red" | "yellow" | "green" }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          notifyGroup = `${PRIORITY_ARABIC[String(approval.payload.newPriority)]} عُدّلت أولوية مهمة «${approval.payload.taskTitle}»`;
          break;
        }
        case "task_close": {
          effect = executeManagementAction(db, actor, { action: "approve", taskId: approval.entityId! }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          notifyGroup = `✅ اعتُمد إغلاق مهمة «${approval.payload.taskTitle}» (${approval.requestedByName})`;
          break;
        }
        case "task_ownership": {
          effect = executeManagementAction(db, actor, { action: "reassign", taskId: approval.entityId!, ownerId: String(approval.payload.requestedOwnerId), expectedUpdatedAt: Number(approval.payload.expectedUpdatedAt) }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id, approvalId: approval.id } });
          notifyGroup = null;
          break;
        }
        case "task_transfer": {
          // A suggested colleague reassigns to them (pending their own claim,
          // same as any other reassignment); no suggestion at all (a plain
          // decline) just clears the assignment -- Basim assigns someone new
          // separately, the same existing "عيّنها لـ..." flow as any other task.
          const suggestedOwnerId = approval.payload.suggestedOwnerId ? String(approval.payload.suggestedOwnerId) : null;
          effect = executeManagementAction(db, actor, { action: "reassign", taskId: approval.entityId!, ownerId: suggestedOwnerId, expectedUpdatedAt: Number(approval.payload.expectedUpdatedAt) }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id, approvalId: approval.id } });
          notifyGroup = suggestedOwnerId
            ? `🔁 حُوّلت مهمة «${approval.payload.taskTitle}» من ${approval.payload.fromOwnerName} إلى ${approval.payload.suggestedOwnerName}`
            : `🔁 ${approval.payload.fromOwnerName} لم يعد مسؤولًا عن «${approval.payload.taskTitle}» — بانتظار تعيين مسؤول جديد`;
          break;
        }
        case "task_create": {
          effect = executeManagementAction(db, actor, { action: "add_task", projectId: String(approval.payload.projectId), title: String(approval.payload.title),
            ...(approval.payload.details ? { details: String(approval.payload.details) } : {}), priority: approval.payload.priority as "red" | "yellow" | "green",
            dueDate: approval.payload.dueDate as string | null, ownerId: approval.payload.ownerId as string | null }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          // Same project-free wording as formatManagementNotice's "create"
          // case in secretary-service.ts for a directly-created task -- an
          // employee's request, once approved, must read identically.
          notifyGroup = `🆕 مهمة جديدة: ${approval.payload.title}${approval.payload.ownerName ? ` — ${approval.payload.ownerName}` : ""}`;
          break;
        }
        case "project_create": {
          const created = executeManagementAction(db, actor, { action: "add_project", name: String(approval.payload.name) }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          const tasks = Array.isArray(approval.payload.tasks) ? approval.payload.tasks as Array<{ title: string; ownerId: string | null; priority: "red" | "yellow" | "green"; dueDate: string | null }> : [];
          for (const task of tasks) executeManagementAction(db, actor, { action: "add_task", projectId: created.entityId, title: task.title, priority: task.priority, dueDate: task.dueDate, ownerId: task.ownerId }, { now: at + 1, source: "approval" });
          effect = created;
          notifyGroup = `📁 مشروع جديد: ${approval.payload.name}${tasks.length ? `\n${tasks.map(task => `• ${task.title}${task.ownerId ? ` — ${task.ownerId}` : ""}`).join("\n")}` : ""}`;
          break;
        }
        case "project_close": {
          effect = executeManagementAction(db, actor, { action: "archive_project", projectId: approval.entityId! }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          notifyGroup = `📁 اعتُمد إغلاق مشروع «${approval.payload.projectName}» (${approval.requestedByName})`;
          break;
        }
        case "rule": case "policy": {
          const id = randomUUID();
          db.prepare("INSERT INTO rules (id,kind,statement,match,effect,active,approved_by,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)")
            .run(id, String(approval.payload.kind ?? "note"), String(approval.payload.statement), JSON.stringify(approval.payload.match ?? {}), JSON.stringify(approval.payload.effect ?? {}), actor.id, at, at);
          db.prepare("UPDATE corrections SET proposed_rule_id=? WHERE proposed_rule_id=?").run(id, approval.id);
          break;
        }
      }
    } else if (approval.type === "task_close" && approval.entityId) {
      const task = db.prepare("SELECT status FROM tasks WHERE id=?").get(approval.entityId);
      if (task && task.status === "approval") effect = executeManagementAction(db, actor, { action: "reject", taskId: approval.entityId, reason: note || "لم يُعتمد الإغلاق" }, { now: at, source: "approval" });
    }
    db.prepare("UPDATE approvals SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE id=? AND status='pending'").run(input.decision, actor.id, note || null, at, approval.id);
    db.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(actor.id, actor.name, input.decision === "approved" ? "approve_request" : "reject_request", approval.entityType, approval.entityId ?? approval.id, JSON.stringify({ summary: `${input.decision === "approved" ? "اعتمد" : "رفض"} ${TYPE_LABEL[approval.type]}: ${approval.summary}`, source: "approval", approvalId: approval.id, note }), at);
    db.exec(nested ? "RELEASE approval_decision" : "COMMIT");
    const decided = hydrate(db.prepare(`${SELECT} WHERE id=?`).get(approval.id) as Record<string, unknown>);
    const notifyRequester = input.decision === "approved"
      ? `✅ وافق باسم على ${TYPE_LABEL[approval.type]}: ${approval.summary}${note ? `\n${note}` : ""}`
      : `❌ لم يعتمد باسم ${TYPE_LABEL[approval.type]}: ${approval.summary}${note ? `\nالسبب: ${note}` : ""}`;
    // task_transfer's requester is the OLD owner giving the task away, never
    // the colleague receiving it (unlike task_ownership, where the requester
    // IS the new owner and notifyRequester already reaches them) -- without
    // this, a named colleague would have a task land on them with zero
    // heads-up. Centralized here so every caller (WhatsApp decide, and the
    // website's own decide_approval action) sends it the same way.
    const notifyExtra: Array<{ userId: string; text: string }> = [];
    if (decided.type === "task_transfer" && decided.status === "approved" && decided.payload.suggestedOwnerId) {
      notifyExtra.push({ userId: String(decided.payload.suggestedOwnerId), text: `📌 عيّن لك باسم مهمة «${String(decided.payload.taskTitle).slice(0, 200)}» (كانت مع ${String(decided.payload.fromOwnerName).slice(0, 100)}). اكتب «استلمت» أو اسم المهمة لبدء التنفيذ.` });
    }
    return { approval: decided, effect, notifyRequester, notifyGroup, notifyExtra };
  } catch (error) { db.exec(nested ? "ROLLBACK TO approval_decision" : "ROLLBACK"); throw error; }
}

/** "وافق على تمديد خالد" → find the single matching pending request; null when ambiguous. */
export function findPendingApproval(db: DatabaseSync, claimed: ManagementActor, hint: { type?: ApprovalType | null; requesterName?: string | null; text?: string | null }): { approval: Approval | null; candidates: Approval[] } {
  const pending = listApprovals(db, claimed, { status: "pending", limit: 200 });
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").toLowerCase();
  let candidates = pending;
  if (hint.type) candidates = candidates.filter(approval => approval.type === hint.type);
  if (hint.requesterName) { const name = normalize(hint.requesterName); candidates = candidates.filter(approval => normalize(approval.requestedByName).includes(name)); }
  if (hint.text && candidates.length > 1) { const words = normalize(hint.text).split(/\s+/).filter(word => word.length > 2); const scored = candidates.filter(approval => words.some(word => normalize(approval.summary).includes(word))); if (scored.length) candidates = scored; }
  if (!hint.type && !hint.requesterName && hint.text) {
    const lower = normalize(hint.text);
    if (/تمديد|مهله|موعد/.test(lower)) candidates = candidates.filter(approval => approval.type === "deadline_extension");
    else if (/اولوي|أهمي|اهمي/.test(lower)) candidates = candidates.filter(approval => approval.type === "priority_change");
    else if (/مشروع/.test(lower) && /اغلاق|سكر|ارشف|انهاء/.test(lower)) candidates = candidates.filter(approval => approval.type === "project_close");
    else if (/اغلاق|انهاء|خلص/.test(lower)) candidates = candidates.filter(approval => approval.type === "task_close");
    else if (/تحويل|حول/.test(lower)) candidates = candidates.filter(approval => approval.type === "task_transfer");
    else if (/مسؤول|مسئول|استلام|استلم/.test(lower)) candidates = candidates.filter(approval => approval.type === "task_ownership");
    else if (/مشروع/.test(lower)) candidates = candidates.filter(approval => approval.type === "project_create");
    else if (/قاعده|سياسه/.test(lower)) candidates = candidates.filter(approval => approval.type === "rule" || approval.type === "policy");
  }
  return { approval: candidates.length === 1 ? candidates[0] : null, candidates };
}

// Basim asked for this after WhatsApp screenshots showed several unrelated
// pending requests crammed into one plain numbered list with no visual
// separation -- on a phone screen he could not tell where one request's
// details ended and the next began, and had no explicit per-item action to
// type. Each request now gets its own block (number, type/summary/requester,
// then an explicit 🟢 approve / 🔴 reject line naming that exact number),
// and multiple requests are separated by a full blank line between blocks --
// shared by every place that lists more than one pending request so the
// format stays one convention everywhere, not just here.
export function formatApprovalChoice(approval: Approval, index: number): string {
  const number = index + 1;
  return `${number}. ${TYPE_LABEL[approval.type]} — ${approval.summary} (${approval.requestedByName})\n🟢 اعتماد: اكتب «اعتمد ${number}»\n🔴 رفض: اكتب «ارفض ${number}»`;
}
export function formatPendingList(approvals: Approval[]): string {
  if (!approvals.length) return "لا يوجد شيء بانتظار قرارك حاليًا.";
  if (approvals.length === 1) return `عندك طلب واحد بانتظار قرارك:\n\n${formatApprovalChoice(approvals[0], 0)}`;
  return `عندك ${approvals.length} طلبات بانتظار قرارك:\n\n${approvals.map((approval, index) => formatApprovalChoice(approval, index)).join("\n\n")}\n\nاختر رقم الطلب، أو قل «اعتمد الكل» أو «ارفض الكل».`;
}

/** Expire stale requests and return those that deserve an owner nudge. */
export function staleApprovals(db: DatabaseSync, at: number, olderThanMs: number): Approval[] {
  migrateManagementActions(db);
  db.prepare("UPDATE approvals SET status='expired',decided_at=? WHERE status='pending' AND created_at<?").run(at, at - APPROVAL_TTL_MS);
  return (db.prepare(`${SELECT} WHERE status='pending' AND created_at<? AND (last_nudged_at IS NULL OR last_nudged_at<?) ORDER BY created_at`).all(at - olderThanMs, at - 24 * 60 * 60_000) as Record<string, unknown>[]).map(hydrate);
}
export function markNudged(db: DatabaseSync, ids: string[], at: number) {
  for (const id of ids) db.prepare("UPDATE approvals SET last_nudged_at=? WHERE id=?").run(at, id);
}
export const approvalTypeLabel = (type: ApprovalType) => TYPE_LABEL[type];
