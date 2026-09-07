/**
 * Synchronous, transport-independent task execution. The caller supplies an
 * existing SQLite handle and authenticated transport origin; neither an LLM nor
 * HTTP payload may supply a trusted actor/catalog. No network calls occur here.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeContactNumber, planChatTaskUpdate, resolveChatUser, visibleChatTasks,
  type ChatContact, type ChatOrigin, type ChatTask, type ChatUser,
} from "./team-chat-policy.ts";
import type { IntentTask, ParsedIntent } from "./whatsapp-intent";

export type TeamChatConfig = {
  contacts: readonly ChatContact[];
  allowedGroupIds?: readonly string[];
};
export type TeamChatTask = ChatTask & IntentTask & { projectId: string };
export type TeamChatCatalog = { ok: true; actor: ChatUser; tasks: TeamChatTask[] };
export type TeamChatEvent = {
  messageId: string;
  origin: ChatOrigin;
  text: string;
  replyToMessageId?: string | null;
};
type ResultStatus = "applied" | "summary" | "clarify" | "denied" | "stale";
export type TeamChatResult = {
  status: ResultStatus | "duplicate";
  reply: string;
  taskId?: string;
  originalStatus?: ResultStatus;
};
type StoredResult = TeamChatResult & { scopeTaskIds: string[] };
type EventRow = { payloadHash: string; actorId: string; resultJson: string };
type IssuedCatalog = { sqlite: DatabaseSync; originKey: string; actor: string; tasks: string };
const issuedCatalogs = new WeakMap<TeamChatCatalog, IssuedCatalog>();
const DENIED = "هذا الرقم أو المحادثة غير مخوّلين لتنفيذ الطلب. تواصل مع باسم.";
const STALE = "المهمة أو صلاحياتها تغيّرت أثناء معالجة رسالتك. ما عدّلتها؛ ابعث تحديثك من جديد.";

export function migrateTeamChatStore(sqlite: DatabaseSync): void {
  // Additive only: no existing tasks, users, comments or history are rewritten.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS team_chat_events (
    message_id TEXT PRIMARY KEY NOT NULL,
    payload_hash TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
}

function transaction<T>(sqlite: DatabaseSync, mode: "read" | "write", work: () => T): T {
  // BEGIN intentionally occurs outside try: a nested transaction must never roll
  // back a transaction belonging to the caller. work is strictly synchronous.
  sqlite.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = work();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function validOrigin(origin: ChatOrigin): boolean {
  return !!origin && typeof origin.senderNumber === "string"
    && normalizeContactNumber(origin.senderNumber) !== null
    && (origin.groupId == null || (typeof origin.groupId === "string" && origin.groupId.length > 0 && origin.groupId.length <= 256));
}

function validEvent(event: TeamChatEvent): boolean {
  return !!event && typeof event.messageId === "string" && /^[^\s\x00-\x1f]{1,256}$/u.test(event.messageId)
    && validOrigin(event.origin) && typeof event.text === "string" && !!event.text.trim() && event.text.length <= 4000
    && (event.replyToMessageId == null || (typeof event.replyToMessageId === "string"
      && /^[^\s\x00-\x1f]{1,256}$/u.test(event.replyToMessageId)));
}

function originKey(origin: ChatOrigin): string {
  return JSON.stringify([normalizeContactNumber(origin.senderNumber), origin.groupId ?? null]);
}

function payloadHash(event: TeamChatEvent): string {
  // Do not hash inferred intent: redelivery can produce a different inference.
  // Text is not trimmed here, so a changed payload cannot reuse the same ID.
  return createHash("sha256").update(JSON.stringify([
    1, originKey(event.origin), event.text, event.replyToMessageId ?? null,
  ])).digest("hex");
}

function namespacedEventKey(event: TeamChatEvent): string {
  // WhatsApp message IDs are not an authorization boundary or guaranteed to be
  // globally unique across all chats. Different authenticated origins may reuse
  // an ID; edited content within the same origin must still fail closed.
  return createHash("sha256").update(JSON.stringify([1, originKey(event.origin), event.messageId])).digest("hex");
}

function actorFor(sqlite: DatabaseSync, origin: ChatOrigin, config: TeamChatConfig): ChatUser | null {
  if (!validOrigin(origin)) return null;
  const users = sqlite.prepare("SELECT id, name, role, active FROM users").all() as ChatUser[];
  return resolveChatUser(origin, [...config.contacts], users, config.allowedGroupIds ?? []);
}

function tasksFor(sqlite: DatabaseSync, actor: ChatUser): TeamChatTask[] {
  const manager = actor.id === "basem" && actor.role === "admin" && actor.active === 1;
  // LIMIT 51 detects an overlarge catalog without silently dropping ambiguity.
  return sqlite.prepare(`SELECT t.id, t.title, t.status, t.owner,
    t.suggested_owner AS suggestedOwner, t.archived_at AS archivedAt,
    t.updated_at AS updatedAt, t.project_id AS projectId, p.name AS projectName,
    t.due_date AS dueDate
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.archived_at IS NULL AND p.status = 'active'
      AND (? = 1 OR t.owner = ? OR (t.owner IS NULL AND t.suggested_owner = ?))
    ORDER BY t.id LIMIT 51`).all(manager ? 1 : 0, actor.name, actor.name) as TeamChatTask[];
}

function snapshot(tasks: TeamChatTask[]): string {
  return JSON.stringify(tasks);
}

export function getTeamChatCatalog(
  sqlite: DatabaseSync, origin: ChatOrigin, config: TeamChatConfig,
): TeamChatCatalog | { ok: false; reply: string } {
  return transaction(sqlite, "read", () => {
    const actor = actorFor(sqlite, origin, config);
    if (!actor) return { ok: false as const, reply: DENIED };
    const tasks = tasksFor(sqlite, actor);
    if (tasks.length > 50) return { ok: false as const, reply: "عندك أكثر من 50 مهمة متاحة. راجع لوحة الإدارة لتحديد المهمة قبل المتابعة." };
    const catalog: TeamChatCatalog = { ok: true, actor, tasks };
    issuedCatalogs.set(catalog, { sqlite, originKey: originKey(origin), actor: JSON.stringify(actor), tasks: snapshot(tasks) });
    // The issued object is never reconstructed from client data. Freezing also
    // prevents accidental caller mutation while an asynchronous model runs.
    Object.freeze(actor);
    tasks.forEach(Object.freeze);
    Object.freeze(tasks);
    Object.freeze(catalog);
    return catalog;
  });
}

function previousEvent(
  sqlite: DatabaseSync, event: TeamChatEvent, actor: ChatUser,
): TeamChatResult | null {
  const row = sqlite.prepare(`SELECT payload_hash AS payloadHash, actor_user_id AS actorId,
    result_json AS resultJson FROM team_chat_events WHERE message_id = ?`).get(namespacedEventKey(event)) as EventRow | undefined;
  if (!row) return null;
  if (row.payloadHash !== payloadHash(event) || row.actorId !== actor.id) {
    return { status: "denied", reply: "معرّف الرسالة مستخدم بمحتوى أو مرسل مختلف. لم أنفّذ أي تعديل." };
  }
  const saved = JSON.parse(row.resultJson) as StoredResult;
  // Do not disclose a cached title/summary after task access was withdrawn.
  const visibleIds = new Set(tasksFor(sqlite, actor).map(task => task.id));
  if (saved.scopeTaskIds.some(id => !visibleIds.has(id))) return { status: "denied", reply: DENIED };
  return {
    status: "duplicate", reply: saved.reply,
    ...(saved.taskId ? { taskId: saved.taskId } : {}),
    originalStatus: saved.status as ResultStatus,
  };
}

/** A cheap pre-inference check; apply repeats it under the write lock. */
export function lookupTeamChatEvent(
  sqlite: DatabaseSync, event: TeamChatEvent, config: TeamChatConfig,
): TeamChatResult | null {
  if (!validEvent(event)) return { status: "denied", reply: "صيغة الرسالة غير صالحة. لم أنفّذ أي تعديل." };
  return transaction(sqlite, "read", () => {
    const actor = actorFor(sqlite, event.origin, config);
    return actor ? previousEvent(sqlite, event, actor) : { status: "denied", reply: DENIED };
  });
}

function safeTitle(value: string, length = 160): string {
  return value.replace(/[\r\n\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, length);
}

function summary(tasks: TeamChatTask[]): string {
  if (!tasks.length) return "ما في مهام متاحة إلك حاليًا.";
  const labels: Record<string, string> = { open: "بانتظار الاستلام", progress: "قيد التنفيذ", approval: "بانتظار باسم", completed: "معتمدة" };
  const lines = tasks.slice(0, 12).map((task, index) => `\u200E${index + 1}\u200E. ${safeTitle(task.title, 120)} — ${safeTitle(task.projectName, 70)}: ${labels[task.status] ?? "راجع اللوحة"}`);
  return `المهام المتاحة إلك (${tasks.length}):\n${lines.join("\n")}${tasks.length > 12 ? "\nبقية المهام موجودة في لوحة الإدارة." : ""}`;
}

export function applyTeamChatIntent(
  sqlite: DatabaseSync,
  input: TeamChatEvent & { intent: ParsedIntent; catalog: TeamChatCatalog },
  config: TeamChatConfig,
): TeamChatResult {
  if (!validEvent(input)) return { status: "denied", reply: "صيغة الرسالة غير صالحة. لم أنفّذ أي تعديل." };
  return transaction(sqlite, "write", () => {
    const actor = actorFor(sqlite, input.origin, config);
    if (!actor) return { status: "denied", reply: DENIED };
    const prior = previousEvent(sqlite, input, actor);
    if (prior) return prior;

    const now = Date.now();
    const save = (result: TeamChatResult, scopeTaskIds: string[] = []): TeamChatResult => {
      const saved: StoredResult = { ...result, scopeTaskIds };
      sqlite.prepare(`INSERT INTO team_chat_events (message_id, payload_hash, actor_user_id, result_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(namespacedEventKey(input), payloadHash(input), actor.id, JSON.stringify(saved), now);
      return result;
    };
    const issued = issuedCatalogs.get(input.catalog);
    if (!issued || issued.sqlite !== sqlite || issued.originKey !== originKey(input.origin)) {
      return save({ status: "denied", reply: DENIED });
    }
    const tasks = tasksFor(sqlite, actor);
    if (issued.actor !== JSON.stringify(actor) || issued.tasks !== snapshot(tasks)) {
      return save({ status: "stale", reply: STALE });
    }
    if (!input.intent || !["summary", "clarify", "claim", "update", "submit"].includes(input.intent.action)
      || !(input.intent.taskId === null || typeof input.intent.taskId === "string")
      || ((input.intent.action === "summary" || input.intent.action === "clarify") && input.intent.taskId !== null)) {
      return save({ status: "denied", reply: "هذا الإجراء غير متاح من المحادثة." });
    }
    const proposal = planChatTaskUpdate(actor, input.intent, tasks, input.text);
    if (proposal.kind === "clarify") return save({ status: "clarify", reply: proposal.message });
    if (proposal.kind === "summary") {
      const visible = visibleChatTasks(actor, tasks) as TeamChatTask[];
      return save({ status: "summary", reply: summary(visible) }, visible.map(task => task.id));
    }

    const task = tasks.find(candidate => candidate.id === proposal.taskId)!;
    // Monotonic versions protect two updates landing in the same millisecond.
    const updatedAt = Math.max(now, (task.updatedAt ?? 0) + 1);
    const changed = sqlite.prepare(`UPDATE tasks SET status = ?, owner = ?,
      started_at = CASE WHEN ? = 1 THEN ? ELSE started_at END,
      rejection_reason = NULL, updated_at = ?
      WHERE id = ? AND archived_at IS NULL AND updated_at IS ? AND status = ?
        AND owner IS ? AND suggested_owner IS ?`).run(
      proposal.nextStatus, actor.name, proposal.claimFirst ? 1 : 0, now, updatedAt,
      task.id, proposal.expectedUpdatedAt, proposal.expectedStatus, task.owner, task.suggestedOwner,
    );
    if (Number(changed.changes) !== 1) return save({ status: "stale", reply: STALE });
    const comment = sqlite.prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)")
      .run(task.id, actor.name, input.text, now);
    sqlite.prepare(`INSERT INTO audit_logs (actor_user_id, actor_name, action, entity_type, entity_id, details, created_at)
      VALUES (?, ?, ?, 'task', ?, ?, ?)`).run(actor.id, actor.name, `chat_${proposal.action}`, task.id, JSON.stringify({
      summary: proposal.nextStatus === "approval" ? "أرسل المهمة لاعتماد باسم من واتساب" : "سجّل تحديث تنفيذ من واتساب",
      source: "team_chat", messageId: input.messageId, commentId: String(comment.lastInsertRowid),
      previousStatus: task.status, nextStatus: proposal.nextStatus, claimed: proposal.claimFirst,
    }), now);
    const reply = proposal.nextStatus === "approval"
      ? `سجّلت إنجاز «${safeTitle(task.title)}» وبعثتها لاعتماد باسم. لسه مش معتمدة نهائيًا.`
      : `سجّلت تحديثك على «${safeTitle(task.title)}» وصارت قيد التنفيذ باسمك.`;
    return save({ status: "applied", reply, taskId: task.id }, [task.id]);
  });
}
