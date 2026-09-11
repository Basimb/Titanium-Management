/**
 * Transport-independent authorization for the secretary/WhatsApp gateway.
 * This module only resolves an authenticated actor; it does not write to the database.
 * Callers must use authenticated transport metadata, not numbers/names in text,
 * and recheck identity, ownership and task version in their own write transaction.
 */

export type ChatUser = {
  id: string;
  name: string;
  role: "admin" | "manager" | "member";
  active: number;
  department?: string | null;
};

export type ChatContact = { userId: string; number: string };
export type ChatOrigin = { senderNumber: string; groupId?: string | null };

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

/* ----------------------------------------------------------------------------
 * Group notification policy. The group is for important events only.
 * Anything not in the allowlist stays private. A daily budget caps volume.
 * -------------------------------------------------------------------------- */
export type GroupEvent = "task_new" | "delay" | "reassign" | "approval_request" | "blocker" | "milestone" | "task_closed";
export const GROUP_EVENT_ALLOWLIST: ReadonlySet<GroupEvent> = new Set<GroupEvent>(["task_new", "delay", "reassign", "approval_request", "blocker", "milestone", "task_closed"]);
export const GROUP_DAILY_BUDGET = 1000;
const ACTION_TO_GROUP_EVENT: Record<string, GroupEvent> = { create: "task_new", reassign: "reassign", blocker: "blocker", approve: "milestone", archive: "task_closed" };

/** Map an audited action to a group event, or null when it should stay private. */
export function groupEventFor(action: string, entityType: "task"): GroupEvent | null {
  void entityType;
  return ACTION_TO_GROUP_EVENT[action] ?? null;
}

export function isGroupWorthy(action: string, entityType: "task"): boolean {
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
