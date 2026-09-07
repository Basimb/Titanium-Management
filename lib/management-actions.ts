import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { migrateAgentSchema } from "./agent-schema.ts";
import { ACTION_CAPABILITY, can, inScope, isOwner, type PermissionActor } from "./permissions.ts";

export type ManagementActor = { id: string; name: string; role: "admin" | "manager" | "member"; active: number; department?: string | null };
type Expected = { expectedUpdatedAt?: number | null; expectedStatus?: string; expectedProjectId?: string;
  expectedProjectUpdatedAt?: number | null; expectedProjectStatus?: string; expectedTargetProjectUpdatedAt?: number | null };
type TaskFields = { title?: string; details?: string; priority?: "red" | "yellow" | "green"; dueDate?: string | null;
  suggestedOwner?: string | null; ownerId?: string | null };
export type ManagementCommand = Expected & (
  | { action: "add_project"; name: string }
  | { action: "edit_project"; projectId: string; name: string }
  | { action: "approve_project" | "restore_project" | "archive_project" | "delete_project"; projectId: string }
  | { action: "reject_project"; projectId: string; reason: string }
  | ({ action: "add_task"; projectId: string; title: string } & TaskFields)
  | ({ action: "edit_task"; taskId: string } & TaskFields)
  | { action: "claim" | "cancel_claim" | "submit" | "approve" | "archive_task" | "restore_task" | "delete_task"; taskId: string }
  | { action: "reject"; taskId: string; reason: string }
  | { action: "reopen"; taskId: string; reason?: string }
  | { action: "reassign"; taskId: string; ownerId: string | null }
  | { action: "move_task"; taskId: string; projectId: string }
  | { action: "comment"; taskId: string; comment: string }
  | { action: "set_watcher"; taskId: string; watcherId: string | null }
  | { action: "set_blocker"; taskId: string; blocker: string | null }
  | { action: "set_expected"; taskId: string; expectedAt: string | null }
);

export type ManagementProject = { id: string; name: string; status: string; createdBy: string; createdAt: number;
  updatedAt: number; rejectionReason: string | null; rejectedBy: string | null; rejectedAt: number | null;
  archivedAt: number | null; archivedBy: string | null };
export type ManagementTask = { id: string; projectId: string; title: string; details: string; priority: string; status: string;
  owner: string | null; suggestedOwner: string | null; startedAt: number | null; dueDate: string | null;
  completedAt: number | null; rejectionReason: string | null; createdAt: number; updatedAt: number | null;
  archivedAt: number | null; archivedBy: string | null;
  watcher: string | null; expectedAt: string | null; blocker: string | null; lastUpdateAt: number | null };
export type ManagementResult = { ok: true; action: ManagementCommand["action"]; entityType: "task" | "project";
  entityId: string; message: string; deletedObjectKeys: string[];
  notification?: { action: string; title: string; actor: string; extra?: string } };

export class ManagementActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "ManagementActionError"; this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new ManagementActionError(status, code, message); };
const PROJECT_SELECT = "SELECT id,name,status,created_by AS createdBy,created_at AS createdAt,COALESCE(updated_at,created_at) AS updatedAt,rejection_reason AS rejectionReason,rejected_by AS rejectedBy,rejected_at AS rejectedAt,archived_at AS archivedAt,archived_by AS archivedBy FROM projects";
const TASK_SELECT = "SELECT id,project_id AS projectId,title,details,priority,status,owner,suggested_owner AS suggestedOwner,started_at AS startedAt,due_date AS dueDate,completed_at AS completedAt,rejection_reason AS rejectionReason,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt,archived_by AS archivedBy,watcher,expected_at AS expectedAt,blocker,last_update_at AS lastUpdateAt FROM tasks";
const EXPECTED_KEYS = ["expectedUpdatedAt", "expectedStatus", "expectedProjectId", "expectedProjectUpdatedAt", "expectedProjectStatus", "expectedTargetProjectUpdatedAt"];
const ACTION_KEYS: Record<ManagementCommand["action"], readonly string[]> = {
  add_project: ["name"], edit_project: ["projectId", "name"], approve_project: ["projectId"], reject_project: ["projectId", "reason"],
  restore_project: ["projectId"], archive_project: ["projectId"], delete_project: ["projectId"],
  add_task: ["projectId", "title", "details", "priority", "dueDate", "suggestedOwner", "ownerId"],
  edit_task: ["taskId", "title", "details", "priority", "dueDate", "suggestedOwner", "ownerId"],
  claim: ["taskId"], cancel_claim: ["taskId"], submit: ["taskId"], approve: ["taskId"], reject: ["taskId", "reason"],
  reopen: ["taskId", "reason"], reassign: ["taskId", "ownerId"], move_task: ["taskId", "projectId"],
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

/** Additive migration only. Call on the same SQLite connection before snapshots/actions. */
export function migrateManagementActions(sqlite: DatabaseSync): void {
  atomic(sqlite, true, () => {
    const columns = new Set(sqlite.prepare("PRAGMA table_info(projects)").all().map(row => String(row.name)));
    if (!columns.has("id")) return fail(503, "schema_unavailable", "بيانات المشاريع غير جاهزة");
    for (const [column, type] of [["updated_at", "INTEGER"], ["archived_at", "INTEGER"], ["archived_by", "TEXT"]]) {
      if (!columns.has(column)) sqlite.exec(`ALTER TABLE projects ADD COLUMN ${column} ${type}`);
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
    const tasks = (sqlite.prepare(`${TASK_SELECT} ORDER BY created_at,id`).all() as ManagementTask[]).filter(task => canViewManagementTask(actor, task));
    const taskIds = new Set(tasks.map(task => task.id));
    const projectIds = new Set(tasks.map(task => task.projectId));
    const projects = (sqlite.prepare(`${PROJECT_SELECT} ORDER BY created_at,id`).all() as ManagementProject[])
      .filter(project => manager || projectIds.has(project.id))
      .map(project => ({ ...project, status: project.archivedAt === null ? project.status : "archived" }));
    const comments = sqlite.prepare("SELECT id,task_id AS taskId,author,body,created_at AS createdAt FROM comments ORDER BY created_at DESC,id DESC")
      .all().filter(row => manager || taskIds.has(String(row.taskId)));
    const users = sqlite.prepare("SELECT id,name,role,active,department,CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS pinSet,created_at AS createdAt,updated_at AS updatedAt FROM users ORDER BY role,created_at,name")
      .all().filter(row => manager || actor.role === "manager" || row.id === actor.id);
    const attachments = sqlite.prepare("SELECT id,task_id AS taskId,file_name AS fileName,content_type AS contentType,size,uploaded_by AS uploadedBy,created_at AS createdAt FROM attachments ORDER BY created_at DESC")
      .all().filter(row => manager || taskIds.has(String(row.taskId)));
    const activity = sqlite.prepare("SELECT id,actor_user_id AS actorUserId,actor_name AS actorName,action,entity_type AS entityType,entity_id AS entityId,details,created_at AS createdAt FROM audit_logs ORDER BY created_at DESC,id DESC")
      .all().filter(row => manager || (row.entityType === "task" && taskIds.has(String(row.entityId)))
        || (row.entityType === "project" && projectIds.has(String(row.entityId))) || (row.entityType === "user" && row.entityId === actor.id))
      .map(row => {
        if (manager) return row;
        let details: Record<string, unknown> = {};
        try { const parsed = JSON.parse(String(row.details)); if (parsed && typeof parsed === "object") details = parsed; } catch { /* Old malformed audit entry. */ }
        return { ...row, details: JSON.stringify({ summary: typeof details.summary === "string" ? details.summary : String(row.action), source: typeof details.source === "string" ? details.source : "site" }) };
      });
    return { currentUser: actor, projects, tasks, comments, users, attachments, activity };
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
function projectById(sqlite: DatabaseSync, id: unknown): ManagementProject {
  const project = sqlite.prepare(`${PROJECT_SELECT} WHERE id=?`).get(identifier(id)) as ManagementProject | undefined;
  return project ?? fail(404, "project_missing", "المشروع غير موجود");
}
function taskById(sqlite: DatabaseSync, id: unknown, actor: ManagementActor): ManagementTask {
  const task = sqlite.prepare(`${TASK_SELECT} WHERE id=?`).get(identifier(id)) as ManagementTask | undefined;
  return task && canViewManagementTask(actor, task) ? task : fail(404, "task_missing", "المهمة غير موجودة أو غير متاحة لك");
}
function checkVersion(command: Expected, task: ManagementTask | null, project: ManagementProject) {
  const mismatch = (key: keyof Expected, actual: unknown) => Object.hasOwn(command, key) && command[key] !== actual;
  const projectStatus = project.archivedAt === null ? project.status : "archived";
  if ((task && (mismatch("expectedUpdatedAt", task.updatedAt) || mismatch("expectedStatus", task.status) || mismatch("expectedProjectId", task.projectId)))
    || mismatch("expectedProjectUpdatedAt", project.updatedAt) || mismatch("expectedProjectStatus", projectStatus)
    || (!task && (mismatch("expectedUpdatedAt", project.updatedAt) || mismatch("expectedStatus", projectStatus)))) {
    fail(409, "stale", "تغيّرت البيانات منذ عرضها. حدّثها ثم أعد تأكيد الطلب");
  }
}
function activeProject(project: ManagementProject) {
  if (project.archivedAt !== null || project.status !== "active") fail(409, "project_inactive", "المشروع ليس نشطًا؛ استرجعه واعتمده قبل تعديل مهامه");
}
function updateRow(sqlite: DatabaseSync, table: "tasks" | "projects", id: string, changes: Record<string, SQLInputValue>) {
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
    let previous: ManagementTask | ManagementProject | null = null;
    let next: ManagementTask | ManagementProject | null = null;
    let entityType: "task" | "project" = "task";
    let entityId = "";
    let message = "تم حفظ التحديث";
    let auditAction = command.action as string;
    let notification: ManagementResult["notification"];
    const deletedObjectKeys: string[] = [];
    const bumpProject = (project: ManagementProject) => updateRow(sqlite, "projects", project.id, { updated_at: Math.max(at, project.updatedAt + 1) });
    const deleteTaskRecords = (taskId: string) => {
      for (const row of sqlite.prepare("SELECT object_key AS objectKey FROM attachments WHERE task_id=?").all(taskId)) deletedObjectKeys.push(String(row.objectKey));
      sqlite.prepare("DELETE FROM attachments WHERE task_id=?").run(taskId);
      sqlite.prepare("DELETE FROM comments WHERE task_id=?").run(taskId);
      sqlite.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
    };

    if (command.action.endsWith("_project")) {
      entityType = "project";
      if (command.action === "add_project") {
        const name = required(command.name, "اسم المشروع"); entityId = randomUUID();
        const status = manager ? "active" : "pending";
        sqlite.prepare("INSERT INTO projects (id,name,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(entityId, name, status, actor.name, at, at);
        message = manager ? `أضاف مشروع: ${name}` : `اقترح مشروعًا بانتظار اعتماد باسم: ${name}`; auditAction = "create";
      } else {
        const projectCommand = command as Exclude<Extract<ManagementCommand, { projectId: string }>, { action: "add_task" | "move_task" }>;
        const project = projectById(sqlite, projectCommand.projectId); previous = project; entityId = project.id;
        checkVersion(command, null, project);
        const changes: Record<string, SQLInputValue> = { updated_at: Math.max(at, project.updatedAt + 1) };
        if (command.action === "delete_project") {
          for (const task of sqlite.prepare("SELECT id FROM tasks WHERE project_id=?").all(project.id)) deleteTaskRecords(String(task.id));
          sqlite.prepare("DELETE FROM projects WHERE id=?").run(project.id);
          message = `حذف المشروع ومهامه نهائيًا: ${project.name}`; auditAction = "delete";
        } else {
          if (project.archivedAt !== null && command.action !== "restore_project") return fail(409, "project_archived", "المشروع مؤرشف؛ استرجعه أولًا");
          if (command.action === "edit_project") { changes.name = required(command.name, "اسم المشروع"); message = `عدّل المشروع: ${project.name}`; auditAction = "edit"; }
          else if (command.action === "archive_project") { changes.archived_at = at; changes.archived_by = actor.name; message = `أرشف المشروع: ${project.name}`; auditAction = "archive"; }
          else if (command.action === "restore_project") {
            if (project.archivedAt !== null) { changes.archived_at = null; changes.archived_by = null; }
            else if (project.status === "rejected") { changes.status = "pending"; changes.rejection_reason = null; changes.rejected_by = null; changes.rejected_at = null; }
            else return fail(409, "invalid_transition", "المشروع ليس مؤرشفًا أو مرفوضًا");
            message = `استرجع المشروع: ${project.name}`; auditAction = "restore";
          } else if (command.action === "approve_project") {
            if (project.status !== "pending") return fail(409, "invalid_transition", "المشروع ليس بانتظار الاعتماد");
            Object.assign(changes, { status: "active", rejection_reason: null, rejected_by: null, rejected_at: null });
            message = `اعتمد المشروع: ${project.name}`; auditAction = "approve";
          } else if (command.action === "reject_project") {
            if (!["pending", "active"].includes(project.status)) return fail(409, "invalid_transition", "حالة المشروع لا تسمح برفضه الآن");
            const reason = required(command.reason, "سبب الرفض", 4000);
            Object.assign(changes, { status: "rejected", rejection_reason: reason, rejected_by: actor.name, rejected_at: at });
            message = `رفض المشروع ${project.name}: ${reason}`; auditAction = "reject";
          }
          updateRow(sqlite, "projects", project.id, changes);
        }
      }
      if (command.action !== "delete_project") next = projectById(sqlite, entityId);
    } else if (command.action === "add_task") {
      const project = projectById(sqlite, command.projectId); activeProject(project); checkVersion(command, null, project);
      const title = required(command.title, "اسم المهمة"); const owner = assignedName(sqlite, command); entityId = randomUUID();
      sqlite.prepare("INSERT INTO tasks (id,project_id,title,details,priority,status,suggested_owner,due_date,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?,?,?)")
        .run(entityId, project.id, title, optionalText(command.details, "التفاصيل", 10_000), priority(command.priority), owner, dateValue(command.dueDate), at, at);
      bumpProject(project); next = taskById(sqlite, entityId, actor);
      message = `أضاف مهمة: ${title}`; auditAction = "create";
      notification = { action: "create", title, actor: actor.name, extra: owner ? `المسؤول: ${owner}` : "غير معيّنة" };
    } else {
      const taskCommand = command as Exclude<Extract<ManagementCommand, { taskId: string }>, never>;
      const task = taskById(sqlite, taskCommand.taskId, actor); previous = task; entityId = task.id;
      const project = projectById(sqlite, task.projectId); checkVersion(command, task, project);
      if (command.action !== "delete_task" && command.action !== "restore_task") {
        if (task.archivedAt !== null) return fail(409, "task_archived", "المهمة مؤرشفة؛ استرجعها أولًا");
        activeProject(project);
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
            if (task.status !== "open" || (task.owner !== null && task.owner !== actor.name)) return fail(409, "invalid_transition", "المهمة ليست متاحة للاستلام");
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
            Object.assign(changes, { status: "completed", completed_at: at, rejection_reason: null });
            message = `اعتمد إنجاز المهمة: ${task.title}`; auditAction = "approve"; break;
          case "reject": {
            if (task.status !== "approval") return fail(409, "invalid_transition", "المهمة ليست بانتظار الاعتماد");
            const reason = required(command.reason, "سبب الرفض", 4000);
            Object.assign(changes, { status: "progress", completed_at: null, rejection_reason: reason });
            message = `رفض الإنجاز وأعاده إلى ${task.owner ?? "المسؤول"}: ${reason}`; auditAction = "reject";
            notification = { action: "reject", title: task.title, actor: actor.name, extra: `السبب: ${reason}` }; break;
          }
          case "reopen":
            if (task.status !== "completed") return fail(409, "invalid_transition", "إعادة الفتح متاحة للمهمة المعتمدة فقط");
            Object.assign(changes, { status: task.owner ? "progress" : "open", completed_at: null, rejection_reason: null });
            message = `أعاد فتح المهمة: ${task.title}${command.reason ? ` — ${optionalText(command.reason, "السبب", 4000)}` : ""}`; auditAction = "reopen"; break;
          case "reassign": {
            if (!Object.hasOwn(command, "ownerId")) return fail(400, "assignee_required", "حدّد الموظف أو اختر إلغاء التعيين");
            const owner = assignedName(sqlite, command);
            Object.assign(changes, { status: "open", owner: null, suggested_owner: owner, started_at: null, completed_at: null, rejection_reason: null });
            message = owner ? `عيّن المهمة إلى ${owner} بانتظار استلامه: ${task.title}` : `ألغى تعيين المسؤول عن المهمة: ${task.title}`; auditAction = "reassign";
            notification = { action: "reassign", title: task.title, actor: actor.name, extra: owner ? `المسؤول: ${owner}` : "غير معيّنة" }; break;
          }
          case "move_task": {
            const destination = projectById(sqlite, command.projectId); activeProject(destination);
            if (Object.hasOwn(command, "expectedTargetProjectUpdatedAt") && command.expectedTargetProjectUpdatedAt !== destination.updatedAt) return fail(409, "stale", "تغيّر مشروع الوجهة؛ راجعه قبل النقل");
            if (destination.id === task.projectId) return fail(409, "same_project", "المهمة موجودة في هذا المشروع بالفعل");
            changes.project_id = destination.id; bumpProject(destination);
            message = `نقل المهمة «${task.title}» من «${project.name}» إلى «${destination.name}»`; auditAction = "move"; break;
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
      bumpProject(project);
      if (!notification && ["claim", "submit", "approve", "archive"].includes(auditAction)) notification = { action: auditAction, title: task.title, actor: actor.name };
    }
    sqlite.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(actor.id, actor.name, auditAction, entityType, entityId, JSON.stringify({ summary: message, source, previous, next, auditContext: context }), at);
    return { ok: true, action: command.action, entityType, entityId, message, deletedObjectKeys, ...(notification ? { notification } : {}) };
  });
}
