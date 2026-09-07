/**
 * Permission engine. Enforced on the server for every action regardless of who
 * proposed it (site, WhatsApp secretary, model). The model never sees this as
 * an instruction; it only sees the outcome.
 *
 * Roles (users.role):
 *   admin   → owner (Basim). Everything, including deciding approvals and rules.
 *   manager → department lead. Creates projects (pending owner approval) and
 *             tasks, assigns within own department, sees department tasks.
 *   member  → employee. Own tasks only: claim, update, comment, request
 *             extension, request close.
 */
export type Role = "admin" | "manager" | "member";
export type PermissionActor = { id: string; name: string; role: Role; active: number; department?: string | null };

export type Capability =
  | "project.create" | "project.edit" | "project.approve" | "project.reject" | "project.archive" | "project.delete"
  | "task.create" | "task.edit" | "task.assign" | "task.move" | "task.archive" | "task.delete"
  | "task.claim" | "task.update" | "task.submit" | "task.approve" | "task.reject" | "task.reopen"
  | "task.watch" | "task.blocker" | "task.expected"
  | "approval.request" | "approval.decide"
  | "rule.propose" | "rule.approve"
  | "knowledge.read" | "knowledge.write"
  | "user.manage" | "message.team" | "report.all";

const OWNER_ONLY: readonly Capability[] = ["project.approve", "project.reject", "project.delete", "task.delete", "task.approve", "task.reject", "task.reopen", "approval.decide", "rule.approve", "user.manage", "message.team", "report.all"];
const MANAGER: readonly Capability[] = ["project.create", "project.edit", "project.archive", "task.create", "task.edit", "task.assign", "task.move", "task.archive", "task.watch", "task.blocker", "task.expected", "task.claim", "task.update", "task.submit", "approval.request", "rule.propose", "knowledge.read", "knowledge.write"];
const MEMBER: readonly Capability[] = ["task.claim", "task.update", "task.submit", "task.blocker", "task.expected", "approval.request", "knowledge.read"];

/** Which actions a manager/member cannot do directly but may request. */
export const REQUESTABLE: Record<string, Capability> = {
  deadline_extension: "task.edit",
  task_close: "task.approve",
  project_create: "project.approve",
  rule: "rule.approve",
  policy: "rule.approve",
};

export function isOwner(actor: PermissionActor): boolean {
  return actor.id === "basem" && actor.role === "admin" && actor.active === 1;
}
export function isManagerRole(actor: PermissionActor): boolean {
  return actor.role === "manager" && actor.active === 1;
}

export function capabilities(actor: PermissionActor): ReadonlySet<Capability> {
  if (actor.active !== 1) return new Set();
  if (isOwner(actor)) return new Set([...OWNER_ONLY, ...MANAGER, ...MEMBER]);
  if (actor.role === "manager") return new Set(MANAGER);
  return new Set(MEMBER);
}

export function can(actor: PermissionActor, capability: Capability): boolean {
  return capabilities(actor).has(capability);
}

/** True when the actor may act on this task at all (view/update scope). */
export function inScope(actor: PermissionActor, task: { owner: string | null; suggestedOwner: string | null; watcher?: string | null }, ownerUser?: PermissionActor | null): boolean {
  if (actor.active !== 1) return false;
  if (isOwner(actor)) return true;
  if (task.owner === actor.name || (task.owner === null && task.suggestedOwner === actor.name) || task.watcher === actor.name) return true;
  if (actor.role === "manager" && actor.department && ownerUser?.department === actor.department) return true;
  return false;
}

/** Map a management action to the capability it needs. */
export const ACTION_CAPABILITY: Record<string, Capability> = {
  add_project: "project.create", edit_project: "project.edit", approve_project: "project.approve", reject_project: "project.reject",
  restore_project: "project.edit", archive_project: "project.archive", delete_project: "project.delete",
  add_task: "task.create", edit_task: "task.edit", claim: "task.claim", cancel_claim: "task.claim", comment: "task.update",
  submit: "task.submit", approve: "task.approve", reject: "task.reject", reopen: "task.reopen", reassign: "task.assign",
  move_task: "task.move", archive_task: "task.archive", restore_task: "task.archive", delete_task: "task.delete",
  set_watcher: "task.watch", set_blocker: "task.blocker", set_expected: "task.expected",
};

export const ROLE_LABEL: Record<Role, string> = { admin: "المدير", manager: "مدير قسم", member: "موظف" };
