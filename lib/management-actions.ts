import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { migrateAgentSchema } from "./agent-schema.ts";
import { ACTION_CAPABILITY, can, inScope, isOwner, type PermissionActor } from "./permissions.ts";

export type ManagementActor = { id: string; name: string; role: "admin" | "manager" | "member"; active: number; department?: string | null };
type Expected = { expectedUpdatedAt?: number | null; expectedStatus?: string };
type TaskFields = { title?: string; details?: string; priority?: "red" | "yellow" | "green"; dueDate?: string | null;
  suggestedOwner?: string | null; ownerId?: string | null };
export type ManagementCommand = Expected & (
  | ({ action: "add_task"; title: string } & TaskFields)
  | ({ action: "edit_task"; taskId: string } & TaskFields)
  | { action: "claim" | "cancel_claim" | "submit" | "approve" | "archive_task" | "restore_task" | "delete_task"; taskId: string }
  | { action: "reject"; taskId: string; reason: string }
  | { action: "reopen"; taskId: string; reason?: string }
  | { action: "reassign"; taskId: string; ownerId: string | null }
  | { action: "comment"; taskId: string; comment: string }
  | { action: "set_watcher"; taskId: string; watcherId: string | null }
  | { action: "set_blocker"; taskId: string; blocker: string | null }
  | { action: "set_expected"; taskId: string; expectedAt: string | null }
);

export type ManagementTask = { id: string; title: string; details: string; priority: string; status: string;
  owner: string | null; suggestedOwner: string | null; startedAt: number | null; dueDate: string | null;
  completedAt: number | null; rejectionReason: string | null; createdAt: number; updatedAt: number | null;
  archivedAt: number | null; archivedBy: string | null;
  watcher: string | null; expectedAt: string | null; blocker: string | null; lastUpdateAt: number | null };
export type ManagementResult = { ok: true; action: ManagementCommand["action"]; entityType: "task";
  entityId: string; message: string; deletedObjectKeys: string[];
  notification?: { action: string; title: string; actor: string; extra?: string } };

export class ManagementActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "ManagementActionError"; this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new ManagementActionError(status, code, message); };
const TASK_SELECT = "SELECT id,title,details,priority,status,owner,suggested_owner AS suggestedOwner,started_at AS startedAt,due_date AS dueDate,completed_at AS completedAt,rejection_reason AS rejectionReason,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt,archived_by AS archivedBy,watcher,expected_at AS expectedAt,blocker,last_update_at AS lastUpdateAt FROM tasks";
const EXPECTED_KEYS = ["expectedUpdatedAt", "expectedStatus"];
export const ACTION_KEYS: Record<ManagementCommand["action"], readonly string[]> = {
  add_task: ["title", "details", "priority", "dueDate", "suggestedOwner", "ownerId"],
  edit_task: ["taskId", "title", "details", "priority", "dueDate", "suggestedOwner", "ownerId"],
  claim: ["taskId"], cancel_claim: ["taskId"], submit: ["taskId"], approve: ["taskId"], reject: ["taskId", "reason"],
  reopen: ["taskId", "reason"], reassign: ["taskId", "ownerId"],
  archive_task: ["taskId"], restore_task: ["taskId"], delete_task: ["taskId"], comment: ["taskId", "comment"],
  set_watcher: ["taskId", "watcherId"], set_blocker: ["taskId", "blocker"], set_expected: ["taskId", "expectedAt"],
};

export function isManagementAction(action: unknown): action is ManagementCommand["action"] {
  return typeof action === "string" && Object.hasOwn(ACTION_KEYS, action);
}

export function parseManagementCommand(value: unknown): ManagementCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "invalid_command", "صيغة الطلب غير صالحة");
  const body = value as Record<string, unknown>;
  if (!isManagementAction(body.action)) return fail(400, "unknown_action", "هذا الإجراء غير متاح");
  const allowed = new Set(["action", ...EXPECTED_KEYS, ...ACTION_KEYS[body.action]]);
  if (Object.keys(body).some(key => !allowed.has(key))) return fail(400, "invalid_fields", "الطلب يحتوي حقولًا غير مسموحة");
  for (const key of EXPECTED_KEYS) {
    if (!Object.hasOwn(body, key)) continue;
    const field = body[key];
    if (key.endsWith("At")) {
      if (!(field === null || (typeof field === "number" && Number.isSafeInteger(field) && field >= 0))) return fail(400, "invalid_version", "نسخة البيانات المطلوبة غير صالحة");
    } else if (typeof field !== "string" || !field.trim() || field.length > 200) return fail(400, "invalid_version", "نسخة البيانات المطلوبة غير صالحة");
  }
  return body as unknown as ManagementCommand;
}

let savepointCounter = 0;
function atomic<T>(sqlite: DatabaseSync, write: boolean, work: () => T): T {
  const nested = sqlite.isTransaction;
  const name = `management_${++savepointCounter}`;
  sqlite.exec(nested ? `SAVEPOINT ${name}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try { const result = work(); sqlite.exec(nested ? `RELEASE ${name}` : "COMMIT"); return result; }
  catch (error) {
    sqlite.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK");
    if (nested) sqlite.exec(`RELEASE ${name}`);
    throw error;
  }
}

/** Additive migration only. Call on the same SQLite connection before snapshots/actions.
 * Projects were removed from the product entirely (tasks are flat, standalone
 * records now), so nothing project-shaped is created or patched here anymore --
 * the one-time destructive drop of the legacy projects table / tasks.project_id
 * column lives in scripts/migrate-drop-projects.sql and is run by hand, never
 * from this per-request path (see the doc comment atop migrateAgentSchema). */
export function migrateManagementActions(sqlite: DatabaseSync): void {
  atomic(sqlite, true, () => {
    const columns = new Set(sqlite.prepare("PRAGMA table_info(tasks)").all().map(row => String(row.name)));
    if (!columns.has("id")) return fail(503, "schema_unavailable", "بيانات المهام غير جاهزة");
    for (const [column, type] of [["updated_at", "INTEGER"], ["archived_at", "INTEGER"], ["archived_by", "TEXT"]]) {
      if (!columns.has(column)) sqlite.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
    }
  });
  migrateAgentSchema(sqlite);
}

export function isManagementAdmin(actor: ManagementActor): boolean {
  return actor.id === "basem" && actor.role === "admin" && actor.active === 1;
}

/** Re-read trusted actor identity. Payload names/roles cannot grant authority. */
export function resolveManagementActor(sqlite: DatabaseSync, claimed: ManagementActor): ManagementActor {
  const actor = claimed && typeof claimed.id === "string"
    ? sqlite.prepare("SELECT id,name,role,active,department FROM users WHERE id=?").get(claimed.id) as ManagementActor | undefined : undefined;
  if (!actor || actor.active !== 1 || actor.name !== claimed.name || actor.role !== claimed.role || claimed.active !== 1
    || !["admin", "manager", "member"].includes(actor.role)) return fail(403, "actor_unavailable", "الحساب غير مفعّل أو تغيّرت صلاحياته؛ سجّل الدخول من جديد");
  return actor;
}

export function canViewManagementTask(actor: ManagementActor, task: Pick<ManagementTask, "owner" | "suggestedOwner"> & { watcher?: string | null }): boolean {
  return inScope(actor as PermissionActor, task);
}

export function getManagementSnapshot(sqlite: DatabaseSync, claimed: ManagementActor) {
  migrateManagementActions(sqlite);
  return atomic(sqlite, false, () => {
    const actor = resolveManagementActor(sqlite, claimed);
    const manager = isManagementAdmin(actor);
    // Basim's explicit instruction: an archived task (whether it archived
    // itself on approval, or was archived manually) shows up NOWHERE for
    // anyone but him -- not in a colleague's own task list, not in a
    // manager's-department view, nothing. He alone keeps the ability to pull
    // one up (the dashboard's "الأرشيف" filter) for the historical record.
    // scope (canViewManagementTask/inScope) still decides visibility for a
    // live task exactly as before; this only adds the archived-hides-from-
    // everyone-but-Basim rule on top of it.
    const tasks = (sqlite.prepare(`${TASK_SELECT} ORDER BY created_at,id`).all() as ManagementTask[])
      .filter(task => manager || (task.archivedAt === null && canViewManagementTask(actor, task)));
    const taskIds = new Set(tasks.map(task => task.id));
    const comments = sqlite.prepare("SELECT id,task_id AS taskId,author,body,created_at AS createdAt FROM comments ORDER BY created_at DESC,id DESC")
      .all().filter(row => manager || taskIds.has(String(row.taskId)));
    // A plain member used to see only their own row here, which fed straight
    // into the WhatsApp secretary's "users" context (both the AI classifier's
    // roster and the ownerId/recipient validation in secretary-intent.ts) --
    // so an employee naming an actual teammate ("حول المهمة لأيمن") looked, to
    // the model and to the validator alike, like there was no such employee at
    // all ("قائمة الموظفين سوى شادي"). Members still can't see the task/project/
    // comment/attachment/activity detail of colleagues (filtered separately
    // below and above), but they need to see who their active colleagues ARE
    // to name them in a transfer, a message, or a correction.
    const users = sqlite.prepare("SELECT id,name,role,active,department,CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS pinSet,created_at AS createdAt,updated_at AS updatedAt FROM users ORDER BY role,created_at,name")
      .all().filter(row => manager || actor.role === "manager" || row.active === 1 || row.id === actor.id);
    const attachments = sqlite.prepare("SELECT id,task_id AS taskId,file_name AS fileName,content_type AS contentType,size,uploaded_by AS uploadedBy,created_at AS createdAt FROM attachments ORDER BY created_at DESC")
      .all().filter(row => manager || taskIds.has(String(row.taskId)));
    const activity = sqlite.prepare("SELECT id,actor_user_id AS actorUserId,actor_name AS actorName,action,entity_type AS entityType,entity_id AS entityId,details,created_at AS createdAt FROM audit_logs ORDER BY created_at DESC,id DESC")
      .all().filter(row => manager || (row.entityType === "task" && taskIds.has(String(row.entityId)))
        || (row.entityType === "user" && row.entityId === actor.id))
      .map(row => {
        if (manager) return row;
        let details: Record<string, unknown> = {};
        try { const parsed = JSON.parse(String(row.details)); if (parsed && typeof parsed === "object") details = parsed; } catch { /* Old malformed audit entry. */ }
        return { ...row, details: JSON.stringify({ summary: typeof details.summary === "string" ? details.summary : String(row.action), source: typeof details.source === "string" ? details.source : "site" }) };
      });
    return { currentUser: actor, tasks, comments, users, attachments, activity };
  });
}

function required(value: unknown, label: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) return fail(400, "invalid_text", `${label} مطلوب وبحد أقصى ${max} حرفًا`);
  return value.trim();
}
function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) return fail(400, "invalid_text", `${label} غير صالح أو أطول من الحد المسموح`);
  return value.trim();
}
function identifier(value: unknown): string { return required(value, "معرّف السجل", 200); }
function dateValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return fail(400, "invalid_date", "الموعد يجب أن يكون تاريخًا صحيحًا");
  return value;
}
function priority(value: unknown): string {
  if (value === undefined) return "yellow";
  if (typeof value !== "string" || !["red", "yellow", "green"].includes(value)) return fail(400, "invalid_priority", "الأولوية غير صالحة");
  return value;
}
function taskById(sqlite: DatabaseSync, id: unknown, actor: ManagementActor): ManagementTask {
  const task = sqlite.prepare(`${TASK_SELECT} WHERE id=?`).get(identifier(id)) as ManagementTask | undefined;
  return task && canViewManagementTask(actor, task) ? task : fail(404, "task_missing", "المهمة غير موجودة أو غير متاحة لك");
}
function checkVersion(command: Expected, task: ManagementTask) {
  const mismatch = (key: keyof Expected, actual: unknown) => Object.hasOwn(command, key) && command[key] !== actual;
  if (mismatch("expectedUpdatedAt", task.updatedAt) || mismatch("expectedStatus", task.status)) {
    fail(409, "stale", "تغيّرت البيانات منذ عرضها. حدّثها ثم أعد تأكيد الطلب");
  }
}
function updateRow(sqlite: DatabaseSync, table: "tasks", id: string, changes: Record<string, SQLInputValue>) {
  const fields = Object.keys(changes);
  if (Number(sqlite.prepare(`UPDATE ${table} SET ${fields.map(field => `${field}=?`).join(",")} WHERE id=?`).run(...Object.values(changes), id).changes) !== 1) fail(409, "stale", "تغيّرت البيانات؛ حدّث الصفحة");
}
function assignedName(sqlite: DatabaseSync, fields: { ownerId?: unknown; suggestedOwner?: unknown }): string | null {
  let byId: string | null | undefined;
  if (Object.hasOwn(fields, "ownerId")) {
    if (fields.ownerId === null || fields.ownerId === "") byId = null;
    else {
      const user = sqlite.prepare("SELECT name FROM users WHERE id=? AND active=1").get(identifier(fields.ownerId));
      if (!user) return fail(400, "assignee_unavailable", "الموظف المختار غير متاح");
      byId = String(user.name);
    }
  }
  let byName: string | null | undefined;
  if (Object.hasOwn(fields, "suggestedOwner")) {
    if (fields.suggestedOwner === null || fields.suggestedOwner === "") byName = null;
    else {
      const name = required(fields.suggestedOwner, "اسم الموظف", 200);
      const user = sqlite.prepare("SELECT name FROM users WHERE name=? AND active=1").get(name);
      if (!user) return fail(400, "assignee_unavailable", "الموظف المختار غير متاح");
      byName = String(user.name);
    }
  }
  if (byId !== undefined && byName !== undefined && byId !== byName) return fail(400, "ambiguous_assignee", "هوية الموظف لا تطابق اسمه");
  return byId !== undefined ? byId : byName ?? null;
}

export function executeManagementAction(sqlite: DatabaseSync, claimed: ManagementActor, rawCommand: ManagementCommand, options: {
  now?: number | (() => number); source?: string; auditContext?: Record<string, unknown>;
} = {}): ManagementResult {
  const command = parseManagementCommand(rawCommand);
  migrateManagementActions(sqlite);
  return atomic(sqlite, true, () => {
    const actor = resolveManagementActor(sqlite, claimed);
    const manager = isManagementAdmin(actor);
    const capability = ACTION_CAPABILITY[command.action];
    if (!capability || !can(actor as PermissionActor, capability)) return fail(403, manager ? "unknown_action" : "admin_required", isOwner(actor as PermissionActor) ? "هذا الإجراء غير متاح" : "هذه العملية تحتاج صلاحية أعلى؛ اطلبها من باسم");
    const at = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
    if (!Number.isSafeInteger(at) || at < 0) return fail(400, "invalid_time", "وقت العملية غير صالح");
    const context: Record<string, unknown> = {};
    for (const key of ["sourceMessageId", "origin", "senderNumber", "originalText", "proposedCommand", "confirmationRequired", "confirmedBy", "confirmationMessageId"]) {
      if (options.auditContext && Object.hasOwn(options.auditContext, key)) context[key] = options.auditContext[key];
    }
    try { if (JSON.stringify(context).length > 24_000) return fail(400, "invalid_audit", "بيانات التدقيق أطول من الحد المسموح"); }
    catch (error) { if (error instanceof ManagementActionError) throw error; return fail(400, "invalid_audit", "بيانات التدقيق غير صالحة"); }
    const source = options.source === undefined ? "site" : required(options.source, "مصدر العملية", 64);
    let previous: ManagementTask | null = null;
    let next: ManagementTask | null = null;
    const entityType = "task" as const;
    let entityId = "";
    let message = "تم حفظ التحديث";
    let auditAction = command.action as string;
    let notification: ManagementResult["notification"];
    const deletedObjectKeys: string[] = [];
    const deleteTaskRecords = (taskId: string) => {
      for (const row of sqlite.prepare("SELECT object_key AS objectKey FROM attachments WHERE task_id=?").all(taskId)) deletedObjectKeys.push(String(row.objectKey));
      sqlite.prepare("DELETE FROM attachments WHERE task_id=?").run(taskId);
      sqlite.prepare("DELETE FROM comments WHERE task_id=?").run(taskId);
      sqlite.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
    };

    if (command.action === "add_task") {
      const title = required(command.title, "اسم المهمة"); const owner = assignedName(sqlite, command); entityId = randomUUID();
      sqlite.prepare("INSERT INTO tasks (id,title,details,priority,status,suggested_owner,due_date,created_at,updated_at) VALUES (?,?,?,?,'open',?,?,?,?)")
        .run(entityId, title, optionalText(command.details, "التفاصيل", 10_000), priority(command.priority), owner, dateValue(command.dueDate), at, at);
      next = taskById(sqlite, entityId, actor);
      message = `أضاف مهمة: ${title}`; auditAction = "create";
      notification = { action: "create", title, actor: actor.name, extra: owner ? `المسؤول: ${owner}` : "غير معيّنة" };
    } else {
      const taskCommand = command as Exclude<Extract<ManagementCommand, { taskId: string }>, never>;
      const task = taskById(sqlite, taskCommand.taskId, actor); previous = task; entityId = task.id;
      checkVersion(command, task);
      if (command.action !== "delete_task" && command.action !== "restore_task") {
        // "reopen" is excluded from this gate on purpose: since approve now
        // auto-archives (see the "approve" case below), a completed task is
        // ALWAYS archived by the time anyone could reopen it, and reopen is
        // exactly the action that is supposed to undo that -- it clears
        // archived_at itself a few lines down. A task archived any other way
        // still can't be reopened (reopen requires status "completed", which
        // a manually-archived open/in-progress task never has), so this
        // stays narrowly scoped to the auto-archive-on-approve case.
        if (task.archivedAt !== null && command.action !== "reopen") return fail(409, "task_archived", "المهمة مؤرشفة؛ استرجعها أولًا");
      }
      const changes: Record<string, SQLInputValue> = { updated_at: Math.max(at, (task.updatedAt ?? 0) + 1) };
      if (command.action === "delete_task") { deleteTaskRecords(task.id); message = `حذف المهمة نهائيًا: ${task.title}`; auditAction = "delete"; }
      else {
        switch (command.action) {
          case "edit_task": {
            const present = ["title", "details", "priority", "dueDate", "suggestedOwner", "ownerId"].filter(key => Object.hasOwn(command, key));
            if (!present.length) return fail(400, "empty_edit", "حدّد التعديل المطلوب");
            if (present.includes("title")) changes.title = required(command.title, "اسم المهمة");
            if (present.includes("details")) changes.details = optionalText(command.details, "التفاصيل", 10_000);
            if (present.includes("priority")) changes.priority = priority(command.priority);
            if (present.includes("dueDate")) changes.due_date = dateValue(command.dueDate);
            if (present.includes("suggestedOwner") || present.includes("ownerId")) {
              const owner = assignedName(sqlite, command);
              if (task.owner !== null && owner !== task.owner) return fail(409, "use_reassign", "لتغيير مسؤول مهمة مستلمة استخدم إعادة التعيين");
              changes.suggested_owner = owner;
            }
            message = `عدّل المهمة: ${task.title}`; auditAction = "edit"; break;
          }
          case "claim":
            // A stale/duplicate poll (an old task-action message tapped after the
            // task has already moved on -- claimed, submitted, rejected back to
            // its owner...) is expected to land here; naming who already has it
            // (or that the tapper already does) tells the tapper what actually
            // happened instead of a generic "not available" that reads like a bug.
            if (task.status !== "open" || (task.owner !== null && task.owner !== actor.name)) return fail(409, "invalid_transition",
              task.owner === actor.name ? "هاي المهمة أصلاً مستلمة عندك من قبل، ما في داعي تستلمها من جديد"
                : task.owner ? `هاي المهمة أصلاً مستلمة من ${task.owner}`
                  : "المهمة ليست متاحة للاستلام");
            if (!manager && task.suggestedOwner !== actor.name) return fail(403, "not_assigned", "هذه المهمة لم يعيّنها باسم لك");
            Object.assign(changes, { status: "progress", owner: actor.name, started_at: at, completed_at: null, rejection_reason: null, last_update_at: at });
            message = `استلم المهمة وبدأ تنفيذها: ${task.title}`; auditAction = "claim"; break;
          case "cancel_claim": {
            if (task.status !== "progress") return fail(409, "invalid_transition", "المهمة ليست قيد التنفيذ");
            if (!manager && task.owner !== actor.name) return fail(403, "not_owned", "المهمة ليست مستلمة باسمك");
            const start = task.startedAt ?? 0;
            if (!manager && (Number(sqlite.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id=? AND created_at>=?").get(task.id, start)?.n)
              + Number(sqlite.prepare("SELECT COUNT(*) AS n FROM attachments WHERE task_id=? AND created_at>=?").get(task.id, start)?.n) > 0)) return fail(403, "progress_exists", "بدأ العمل على المهمة؛ لا يمكن إرجاعها الآن. تواصل مع باسم");
            Object.assign(changes, { status: "open", owner: null, started_at: null, completed_at: null, rejection_reason: null });
            message = `ألغى استلام المهمة: ${task.title}`; auditAction = "unclaim"; break;
          }
          case "comment": {
            if (!manager && task.watcher !== actor.name && (task.owner !== actor.name || task.status !== "progress")) return fail(403, "not_owned", "يمكنك إضافة تحديث فقط على مهمة استلمتها وهي قيد التنفيذ");
            const comment = required(command.comment, "التعليق", 10_000);
            const inserted = sqlite.prepare("INSERT INTO comments (task_id,author,body,created_at) VALUES (?,?,?,?)").run(task.id, actor.name, comment, at);
            changes.last_update_at = at;
            message = `أضاف تعليق #${String(inserted.lastInsertRowid)} على المهمة: ${task.title}`; auditAction = "comment";
            notification = { action: "comment", title: task.title, actor: actor.name, extra: comment.slice(0, 300) }; break;
          }
          case "submit":
            if (!manager && task.owner !== actor.name) return fail(403, "not_owned", "المهمة ليست مستلمة باسمك");
            if (task.status !== "progress") return fail(409, "invalid_transition", "المهمة ليست قيد التنفيذ");
            Object.assign(changes, { status: "approval", completed_at: null, rejection_reason: null, last_update_at: at });
            message = `أرسل المهمة لاعتماد باسم: ${task.title}`; auditAction = "submit"; break;
          case "approve":
            if (task.status !== "approval") return fail(409, "invalid_transition", "المهمة ليست بانتظار الاعتماد");
            // Basim's explicit instruction: any task that gets approved is DONE,
            // full stop -- archive it the same moment, don't wait for a separate
            // manual archive_task. Combined with the manager-only read in
            // getManagementSnapshot below, this makes a completed task disappear
            // from every listing/report for everyone but Basim right away; he can
            // still pull it up (dashboard's "الأرشيف" filter, or restore_task) for
            // the historical record. reopen/restore_task both already require
            // restore_task first on an archived task (the "task is archived,
            // restore it first" gate a few lines up) -- same two-step an admin
            // already needed for a manually-archived task, now also covering one
            // that archived itself on approval.
            // A task is a standalone record now, so approving one closes exactly
            // that one task -- there is no containing entity left to auto-close
            // alongside it (projects were removed from the product entirely).
            Object.assign(changes, { status: "completed", completed_at: at, rejection_reason: null, archived_at: at, archived_by: actor.name });
            message = `اعتمد إنجاز المهمة: ${task.title} (وأُرشفت تلقائيًا)`; auditAction = "approve"; break;
          case "reject": {
            if (task.status !== "approval") return fail(409, "invalid_transition", "المهمة ليست بانتظار الاعتماد");
            const reason = required(command.reason, "سبب الرفض", 4000);
            Object.assign(changes, { status: "progress", completed_at: null, rejection_reason: reason });
            message = `رفض الإنجاز وأعاده إلى ${task.owner ?? "المسؤول"}: ${reason}`; auditAction = "reject";
            notification = { action: "reject", title: task.title, actor: actor.name, extra: `السبب: ${reason}` }; break;
          }
          case "reopen":
            if (task.status !== "completed") return fail(409, "invalid_transition", "إعادة الفتح متاحة للمهمة المكتملة فقط");
            Object.assign(changes, { status: task.owner ? "progress" : "open", completed_at: null, rejection_reason: null, archived_at: null, archived_by: null });
            message = `أعاد فتح المهمة: ${task.title}${command.reason ? ` — ${optionalText(command.reason, "السبب", 4000)}` : ""}`; auditAction = "reopen"; break;
          case "reassign": {
            if (!Object.hasOwn(command, "ownerId")) return fail(400, "assignee_required", "حدّد الموظف أو اختر إلغاء التعيين");
            const owner = assignedName(sqlite, command);
            Object.assign(changes, { status: "open", owner: null, suggested_owner: owner, started_at: null, completed_at: null, rejection_reason: null });
            message = owner ? `عيّن المهمة إلى ${owner} بانتظار استلامه: ${task.title}` : `ألغى تعيين المسؤول عن المهمة: ${task.title}`; auditAction = "reassign";
            notification = { action: "reassign", title: task.title, actor: actor.name, extra: owner ? `المسؤول: ${owner}` : "غير معيّنة" }; break;
          }
          case "archive_task": changes.archived_at = at; changes.archived_by = actor.name; message = `أرشف المهمة: ${task.title}`; auditAction = "archive"; break;
          case "set_watcher": {
            let watcher: string | null = null;
            if (command.watcherId !== null && command.watcherId !== "") {
              const user = sqlite.prepare("SELECT name FROM users WHERE id=? AND active=1").get(identifier(command.watcherId));
              if (!user) return fail(400, "assignee_unavailable", "الموظف المختار غير متاح");
              watcher = String(user.name);
            }
            changes.watcher = watcher; message = watcher ? `عيّن ${watcher} متابعًا للمهمة: ${task.title}` : `ألغى متابع المهمة: ${task.title}`; auditAction = "watch"; break;
          }
          case "set_blocker": {
            if (!manager && task.owner !== actor.name) return fail(403, "not_owned", "المهمة ليست مستلمة باسمك");
            const blocker = command.blocker === null || command.blocker === "" ? null : required(command.blocker, "سبب التعطيل", 1000);
            changes.blocker = blocker; changes.last_update_at = at;
            message = blocker ? `سجّل معطّلًا على المهمة «${task.title}»: ${blocker}` : `أزال المعطّل عن المهمة: ${task.title}`; auditAction = "blocker";
            if (blocker) notification = { action: "blocker", title: task.title, actor: actor.name, extra: blocker.slice(0, 300) }; break;
          }
          case "set_expected": {
            if (!manager && task.owner !== actor.name) return fail(403, "not_owned", "المهمة ليست مستلمة باسمك");
            const expected = dateValue(command.expectedAt);
            changes.expected_at = expected; changes.last_update_at = at;
            message = expected ? `حدّد موعدًا متوقعًا للإنجاز ${expected}: ${task.title}` : `أزال الموعد المتوقع: ${task.title}`; auditAction = "expected"; break;
          }
          case "restore_task":
            if (task.archivedAt === null) return fail(409, "invalid_transition", "المهمة ليست مؤرشفة");
            changes.archived_at = null; changes.archived_by = null; message = `استرجع المهمة من الأرشيف: ${task.title}`; auditAction = "restore"; break;
          default: return fail(400, "unknown_action", "هذا الإجراء غير متاح");
        }
        updateRow(sqlite, "tasks", task.id, changes);
        // The actor may intentionally release a legacy task and lose visibility after this authorized mutation.
        next = sqlite.prepare(`${TASK_SELECT} WHERE id=?`).get(task.id) as ManagementTask;
      }
      if (!notification && ["claim", "submit", "approve", "archive"].includes(auditAction)) notification = { action: auditAction, title: task.title, actor: actor.name };
    }
    sqlite.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(actor.id, actor.name, auditAction, entityType, entityId, JSON.stringify({ summary: message, source, previous, next, auditContext: context }), at);
    return { ok: true, action: command.action, entityType, entityId, message, deletedObjectKeys, ...(notification ? { notification } : {}) };
  });
}
