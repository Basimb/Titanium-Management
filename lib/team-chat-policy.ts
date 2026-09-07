/**
 * Transport-independent authorization for conversational task updates.
 * This module only produces proposals; it does not write to the database.
 * Callers must use authenticated transport metadata, not numbers/names in text,
 * and recheck identity, ownership and task version in the write transaction.
 */
import type { ParsedIntent } from "./whatsapp-intent";

export type ChatUser = {
  id: string;
  name: string;
  role: "admin" | "manager" | "member";
  active: number;
  department?: string | null;
};

export type ChatTask = {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  suggestedOwner: string | null;
  archivedAt: number | null;
  updatedAt: number | null;
};

export type ChatContact = { userId: string; number: string };
export type ChatOrigin = { senderNumber: string; groupId?: string | null };

export type TaskProposal =
  | { kind: "summary"; taskIds: string[] }
  | { kind: "clarify"; message: string }
  | {
      kind: "mutation";
      actorId: string;
      taskId: string;
      expectedUpdatedAt: number | null;
      expectedStatus: string;
      action: "claim" | "update" | "submit";
      nextStatus: "progress" | "approval";
      claimFirst: boolean;
      originalText: string;
    };

export function normalizeContactNumber(value: string): string | null {
  // Formatting is allowed, arbitrary text that happens to contain digits is not.
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  const number = value.replace(/\D/g, "").replace(/^00/, "");
  return /^[1-9]\d{7,14}$/.test(number) ? number : null;
}

export function resolveChatUser(
  origin: ChatOrigin,
  contacts: ChatContact[],
  users: ChatUser[],
  allowedGroupIds: readonly string[] = [],
): ChatUser | null {
  if (origin.groupId != null && (!origin.groupId || !allowedGroupIds.includes(origin.groupId))) return null;
  const number = normalizeContactNumber(origin.senderNumber);
  if (!number) return null;
  const matches = contacts.filter(contact => normalizeContactNumber(contact.number) === number);
  // Ambiguous mappings must be repaired by an administrator, never guessed.
  if (matches.length !== 1) return null;
  const found = users.filter(user => user.id === matches[0].userId && user.active === 1);
  return found.length === 1 ? found[0] : null;
}

function isManager(user: ChatUser) {
  return user.id === "basem" && user.role === "admin" && user.active === 1;
}

export function visibleChatTasks(user: ChatUser, tasks: ChatTask[]): ChatTask[] {
  if (user.active !== 1) return [];
  return tasks.filter(task => {
    if (task.archivedAt !== null) return false;
    if (isManager(user)) return true;
    // A suggested owner must not gain access to another person's claimed task.
    return task.owner === user.name || (task.owner === null && task.suggestedOwner === user.name);
  });
}

export function planChatTaskUpdate(
  user: ChatUser,
  intent: ParsedIntent,
  tasks: ChatTask[],
  originalText: string,
): TaskProposal {
  const ask = (message: string): TaskProposal => ({ kind: "clarify", message });
  if (user.active !== 1) return ask("حسابك غير مفعّل. تواصل مع باسم.");
  if (!originalText.trim() || originalText.length > 4000) return ask("ابعث تحديثًا واضحًا وقصيرًا عن مهمة واحدة.");
  const visible = visibleChatTasks(user, tasks);
  if (intent.action === "summary") return { kind: "summary", taskIds: visible.map(task => task.id) };
  if (intent.action === "clarify") return ask("عن أي مهمة بتحكي، وشو أنجزت فيها؟");
  // Check the allow-list again at this boundary, even when the parser validated it.
  if (!["claim", "update", "submit"].includes(intent.action)) return ask("هذا الإجراء غير متاح من المحادثة.");
  const matches = visible.filter(task => task.id === intent.taskId);
  if (matches.length !== 1) return ask("ما قدرت أحدد مهمة متاحة إلك. اذكر اسم المهمة والمشروع.");
  const task = matches[0];
  if (task.status === "completed") return ask("المهمة معتمدة بالفعل. تواصل مع باسم إذا بدها تعديل.");
  if (task.status === "approval") return ask("المهمة بانتظار اعتماد باسم. ما غيّرت حالتها.");
  if (task.status !== "open" && task.status !== "progress") return ask("حالة المهمة تغيّرت. خلينا نراجعها قبل التعديل.");

  // An admin may view every task, but natural progress reports remain personal.
  // This parser intentionally cannot approve, reject, reassign, delete, or edit deadlines.
  const owned = task.owner === user.name;
  const assigned = task.owner === null && task.suggestedOwner === user.name;
  if (!owned && !assigned) return ask("تحديث التنفيذ يخص الموظف المعيّن للمهمة. استخدم لوحة الإدارة للإجراءات الإدارية.");
  if (task.status === "progress" && !owned) return ask("المهمة ليست مستلمة باسمك حاليًا.");
  if (intent.action === "claim" && task.status !== "open") return ask("المهمة مستلمة باسمك وقيد التنفيذ بالفعل. احكيلي شو أنجزت.");
  return {
    kind: "mutation",
    actorId: user.id,
    taskId: task.id,
    expectedUpdatedAt: task.updatedAt,
    expectedStatus: task.status,
    action: intent.action as "claim" | "update" | "submit",
    nextStatus: intent.action === "submit" ? "approval" : "progress",
    claimFirst: task.status === "open",
    originalText: originalText.trim(),
  };
}

/* ----------------------------------------------------------------------------
 * Group notification policy. The group is for important events only.
 * Anything not in the allowlist stays private. A daily budget caps volume.
 * -------------------------------------------------------------------------- */
export type GroupEvent = "project_new" | "task_new" | "delay" | "reassign" | "approval_request" | "blocker" | "milestone" | "project_closed";
export const GROUP_EVENT_ALLOWLIST: ReadonlySet<GroupEvent> = new Set<GroupEvent>(["project_new", "task_new", "delay", "reassign", "approval_request", "blocker", "milestone", "project_closed"]);
export const GROUP_DAILY_BUDGET = 12;
const ACTION_TO_GROUP_EVENT: Record<string, GroupEvent> = { create: "task_new", reassign: "reassign", blocker: "blocker", approve: "milestone", archive_project: "project_closed" };

/** Map an audited action to a group event, or null when it should stay private. */
export function groupEventFor(action: string, entityType: "task" | "project"): GroupEvent | null {
  if (entityType === "project" && action === "create") return "project_new";
  if (entityType === "project" && action === "archive") return "project_closed";
  return ACTION_TO_GROUP_EVENT[action] ?? null;
}

export function isGroupWorthy(action: string, entityType: "task" | "project"): boolean {
  const event = groupEventFor(action, entityType);
  return !!event && GROUP_EVENT_ALLOWLIST.has(event);
}

/** Remaining group messages for the current day (counted from agent_followups + team_chat sends when present). */
export function groupBudgetRemaining(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, at: number): number {
  const since = at - 24 * 60 * 60_000;
  let used = 0;
  try { used = Number((db.prepare("SELECT COUNT(*) AS n FROM agent_followups WHERE target_user='group' AND sent_at>=?").get(since) as { n: number } | undefined)?.n ?? 0); } catch { used = 0; }
  return Math.max(0, GROUP_DAILY_BUDGET - used);
}
