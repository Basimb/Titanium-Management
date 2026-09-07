import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeManagementAction, getManagementSnapshot, ManagementActionError, migrateManagementActions, resolveManagementActor, type ManagementActor, type ManagementResult, type ManagementTask } from "./management-actions.ts";
import { can, isOwner, type PermissionActor } from "./permissions.ts";

export type ApprovalType = "deadline_extension" | "task_close" | "project_create" | "rule" | "policy";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type Approval = {
  id: string; type: ApprovalType; status: ApprovalStatus; requestedBy: string; requestedByName: string;
  entityType: "task" | "project" | "rule"; entityId: string | null; summary: string; payload: Record<string, unknown>;
  decidedBy: string | null; decisionNote: string | null; createdAt: number; decidedAt: number | null; lastNudgedAt: number | null;
};
export type ApprovalDecision = { approval: Approval; effect: ManagementResult | null; notifyRequester: string; notifyGroup: string | null };

export class ApprovalError extends ManagementActionError {}
const fail = (status: number, code: string, message: string): never => { throw new ApprovalError(status, code, message); };
const SELECT = "SELECT id,type,status,requested_by AS requestedBy,requested_by_name AS requestedByName,entity_type AS entityType,entity_id AS entityId,summary,payload,decided_by AS decidedBy,decision_note AS decisionNote,created_at AS createdAt,decided_at AS decidedAt,last_nudged_at AS lastNudgedAt FROM approvals";
const TYPE_LABEL: Record<ApprovalType, string> = { deadline_extension: "تمديد موعد", task_close: "اعتماد إغلاق مهمة", project_create: "فتح مشروع", rule: "اعتماد قاعدة", policy: "اعتماد سياسة" };
export const APPROVAL_TTL_MS = 14 * 24 * 60 * 60_000;

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

/** Employee asks for more time. Nothing changes on the task until the owner decides. */
export function requestDeadlineExtension(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; newDueDate: string; reason: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const task = visibleTask(db, actor, input.taskId);
  if (!isOwner(actor as PermissionActor) && task.owner !== actor.name) return fail(403, "not_owned", "التمديد متاح للمسؤول عن المهمة فقط");
  if (task.status === "completed") return fail(409, "invalid_transition", "المهمة معتمدة بالفعل");
  const newDueDate = dateOnly(input.newDueDate, "الموعد المقترح");
  if (task.dueDate && newDueDate <= task.dueDate) return fail(400, "not_extension", "الموعد المقترح يجب أن يكون بعد الموعد الحالي");
  const reason = text(input.reason, "سبب التمديد", 1000);
  const summary = `تمديد «${task.title}» من ${task.dueDate ?? "بدون موعد"} إلى ${newDueDate}`;
  const approval = insert(db, actor, { type: "deadline_extension", entityType: "task", entityId: task.id, summary, payload: { oldDueDate: task.dueDate, newDueDate, reason, taskTitle: task.title, expectedUpdatedAt: task.updatedAt } }, now(options));
  const ownerMessage = `${actor.name} طلب تمديد مهمة «${task.title}»\nالموعد السابق: ${task.dueDate ?? "غير محدد"}\nالموعد المقترح: ${newDueDate}\nالسبب: ${reason}\n\nأوافق؟ (اعتمد / ارفض)`;
  return { approval, ownerMessage };
}

/** Employee says the work is done. Task moves to approval (existing submit) and a durable request is filed. */
export function requestTaskClose(db: DatabaseSync, claimed: ManagementActor, input: { taskId: string; result: string }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string; effect: ManagementResult } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const task = visibleTask(db, actor, input.taskId);
  const result = text(input.result, "نتيجة التنفيذ", 4000);
  const at = now(options);
  if (task.status === "progress") executeManagementAction(db, actor, { action: "comment", taskId: task.id, comment: `نتيجة التنفيذ: ${result}` }, { now: at, source: "approval" });
  const effect = task.status === "approval" ? null : executeManagementAction(db, actor, { action: "submit", taskId: task.id }, { now: at, source: "approval" });
  const summary = `إغلاق «${task.title}»`;
  const approval = insert(db, actor, { type: "task_close", entityType: "task", entityId: task.id, summary, payload: { result, taskTitle: task.title } }, at);
  const ownerMessage = `${actor.name} يقول إن مهمة «${task.title}» انتهت.\nالنتيجة: ${result}\n\nهل تعتمد الإغلاق؟ (اعتمد / ارفض مع السبب)`;
  return { approval, ownerMessage, effect: effect ?? { ok: true, action: "submit", entityType: "task", entityId: task.id, message: "المهمة بانتظار الاعتماد", deletedObjectKeys: [] } };
}

/** Manager/employee proposes a project. Created as pending and filed as a request. */
export function requestProjectCreate(db: DatabaseSync, claimed: ManagementActor, input: { name: string; goal?: string; tasks?: Array<{ title: string; ownerId?: string | null; priority?: "red" | "yellow" | "green"; dueDate?: string | null }> }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const name = text(input.name, "اسم المشروع", 240);
  const goal = text(input.goal, "الهدف", 2000, true);
  const tasks = (input.tasks ?? []).slice(0, 40).map(task => ({ title: text(task.title, "اسم المهمة", 240), ownerId: task.ownerId ?? null, priority: task.priority ?? "yellow", dueDate: task.dueDate ?? null }));
  const summary = `فتح مشروع «${name}»${tasks.length ? ` مع ${tasks.length} مهام` : ""}`;
  const approval = insert(db, actor, { type: "project_create", entityType: "project", entityId: null, summary, payload: { name, goal, tasks } }, now(options));
  const lines = tasks.map((task, index) => `${index + 1}. ${task.title}${task.ownerId ? ` — ${task.ownerId}` : ""} — ${task.priority}${task.dueDate ? ` — ${task.dueDate}` : ""}`);
  const ownerMessage = `${actor.name} يقترح فتح مشروع «${name}»${goal ? `\nالهدف: ${goal}` : ""}${lines.length ? `\nالمهام:\n${lines.join("\n")}` : ""}\n\nأعتمد الإنشاء؟`;
  return { approval, ownerMessage };
}

/** A rule/policy proposal (from a correction pattern or an explicit statement). */
export function requestRule(db: DatabaseSync, claimed: ManagementActor, input: { kind: "assignment" | "policy" | "note"; statement: string; match?: Record<string, unknown>; effect?: Record<string, unknown> }, options: { now?: number } = {}): { approval: Approval; ownerMessage: string } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  const statement = text(input.statement, "نص القاعدة", 1000);
  const approval = insert(db, actor, { type: input.kind === "policy" ? "policy" : "rule", entityType: "rule", entityId: null, summary: statement, payload: { kind: input.kind, statement, match: input.match ?? {}, effect: input.effect ?? {} } }, now(options));
  return { approval, ownerMessage: `اقتراح قاعدة:\n${statement}\n\nأعتمدها؟` };
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
        case "task_close": {
          effect = executeManagementAction(db, actor, { action: "approve", taskId: approval.entityId! }, { now: at, source: "approval", auditContext: { origin: "approval", confirmedBy: actor.id } });
          notifyGroup = `✅ اعتُمد إغلاق مهمة «${approval.payload.taskTitle}» (${approval.requestedByName})`;
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
    return { approval: decided, effect, notifyRequester, notifyGroup };
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
    else if (/اغلاق|انهاء|خلص/.test(lower)) candidates = candidates.filter(approval => approval.type === "task_close");
    else if (/مشروع/.test(lower)) candidates = candidates.filter(approval => approval.type === "project_create");
    else if (/قاعده|سياسه/.test(lower)) candidates = candidates.filter(approval => approval.type === "rule" || approval.type === "policy");
  }
  return { approval: candidates.length === 1 ? candidates[0] : null, candidates };
}

export function formatPendingList(approvals: Approval[]): string {
  if (!approvals.length) return "لا يوجد شيء بانتظار قرارك حاليًا.";
  return `عندك ${approvals.length} ${approvals.length === 1 ? "طلب" : "طلبات"} بانتظار قرارك:\n${approvals.map((approval, index) => `${index + 1}. ${TYPE_LABEL[approval.type]} — ${approval.summary} (${approval.requestedByName})`).join("\n")}\n\nقل مثلًا: «اعتمد الأول» أو «ارفض تمديد خالد، السبب...»`;
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
