/**
 * Proactive follow-up without spam.
 *  - overdue / silent task   → private message to the task owner, at most once per task per 24h
 *  - stale approvals (>48h)  → private nudge to Basim, at most once per day
 *  - daily digest            → one group message per day (only if something is overdue), inside working hours
 * Uses the same deliverNext(send) contract as secretary-jobs so the bridge drains it identically.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatPendingList, staleApprovals, markNudged } from "./approvals.ts";
import { getManagementSnapshot, migrateManagementActions, type ManagementActor, type ManagementTask } from "./management-actions.ts";
import { GROUP_EVENT_ALLOWLIST, groupBudgetRemaining } from "./team-chat-policy.ts";

export type FollowupConfig = { enabled: boolean; contacts: Array<{ userId: string; number: string }>; groupId?: string | null; workStartHour?: number; workEndHour?: number; timezoneOffsetMinutes?: number; publicUrl?: string };
type Planned = { id: string; kind: "overdue_task" | "silent_task" | "stale_approval" | "daily_digest"; targetUser: string; entityId: string | null; to: string; text: string };
const DAY = 24 * 60 * 60_000, SILENT_AFTER = 3 * DAY, STALE_APPROVAL_AFTER = 2 * DAY;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
const clean = (value: string) => value.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);

function ownerActor(db: DatabaseSync): ManagementActor | null {
  const row = db.prepare("SELECT id,name,role,active,department FROM users WHERE id='basem' AND role='admin' AND active=1").get() as ManagementActor | undefined;
  return row ?? null;
}
function localHour(at: number, offsetMinutes: number) { return new Date(at + offsetMinutes * 60_000).getUTCHours(); }
function localDay(at: number, offsetMinutes: number) { return new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10); }
function alreadySent(db: DatabaseSync, kind: string, targetUser: string, entityId: string | null, since: number) {
  return !!db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND COALESCE(entity_id,'')=COALESCE(?,'') AND sent_at>=? LIMIT 1").get(kind, targetUser, entityId, since);
}

export function planFollowups(db: DatabaseSync, config: FollowupConfig, at: number): Planned[] {
  migrateManagementActions(db);
  if (!config.enabled) return [];
  const offset = config.timezoneOffsetMinutes ?? 180; // Amman/Riyadh +03:00
  const hour = localHour(at, offset);
  if (hour < (config.workStartHour ?? 9) || hour >= (config.workEndHour ?? 18)) return [];
  const owner = ownerActor(db); if (!owner) return [];
  const numberOf = (userId: string) => config.contacts.find(contact => contact.userId === userId)?.number.replace(/\D/g, "").replace(/^00/, "") ?? null;
  const snapshot = getManagementSnapshot(db, owner);
  const users = snapshot.users as Array<{ id: string; name: string; active: number }>;
  const userIdByName = new Map(users.map(user => [user.name, user.id]));
  const today = localDay(at, offset);
  const plans: Planned[] = [];
  const link = config.publicUrl ? `\n${config.publicUrl}` : "";
  const overdueTasks: ManagementTask[] = [];
  for (const task of snapshot.tasks) {
    if (task.archivedAt || ["completed", "approval"].includes(task.status) || !task.owner) continue;
    const project = snapshot.projects.find(candidate => candidate.id === task.projectId);
    if (!project || project.status !== "active") continue;
    const userId = userIdByName.get(task.owner); const number = userId ? numberOf(userId) : null;
    if (!userId || !number) continue;
    const overdue = !!task.dueDate && task.dueDate < today;
    const expectedPassed = !!task.expectedAt && task.expectedAt < today;
    const silent = task.status === "progress" && (task.lastUpdateAt ?? task.startedAt ?? task.createdAt) < at - SILENT_AFTER;
    if (overdue) overdueTasks.push(task);
    // One nudge per task per day, whatever its kind: never stack overdue + silent on the same person.
    const nudgedToday = alreadySent(db, "overdue_task", userId, task.id, at - DAY) || alreadySent(db, "silent_task", userId, task.id, at - DAY);
    if (nudgedToday) continue;
    if (overdue || expectedPassed) {
      plans.push({ id: randomBytes(8).toString("hex"), kind: "overdue_task", targetUser: userId, entityId: task.id, to: `${number}@s.whatsapp.net`,
        text: `⏰ يا ${clean(task.owner)}، مهمة «${clean(task.title)}» كان موعدها ${task.dueDate ?? task.expectedAt} ولم تُغلق بعد.\nوين وصلت؟ إذا بدك تمديد قلّي الموعد الجديد والسبب وأرفعه لباسم.${link}` });
    } else if (silent && !alreadySent(db, "silent_task", userId, task.id, at - 2 * DAY)) {
      plans.push({ id: randomBytes(8).toString("hex"), kind: "silent_task", targetUser: userId, entityId: task.id, to: `${number}@s.whatsapp.net`,
        text: `👋 يا ${clean(task.owner)}، ما وصلني تحديث على «${clean(task.title)}» من 3 أيام. وين وصلت؟ اكتب لي أو سجّل صوت وأنا أحدّثها.` });
    }
  }
  const ownerNumber = numberOf(owner.id);
  if (ownerNumber && !alreadySent(db, "stale_approval", owner.id, null, at - DAY)) {
    const stale = staleApprovals(db, at, STALE_APPROVAL_AFTER);
    if (stale.length) plans.push({ id: randomBytes(8).toString("hex"), kind: "stale_approval", targetUser: owner.id, entityId: null, to: `${ownerNumber}@s.whatsapp.net`, text: `يا باسم، هذه الطلبات معلّقة من أكثر من يومين:\n${formatPendingList(stale)}` });
  }
  if (config.groupId && overdueTasks.length && !alreadySent(db, "daily_digest", "group", null, at - DAY) && groupBudgetRemaining(db, at) > 0 && GROUP_EVENT_ALLOWLIST.has("delay")) {
    const lines = overdueTasks.slice(0, 12).map(task => `• ${clean(task.title)} — ${task.owner} — ${task.dueDate}`);
    plans.push({ id: randomBytes(8).toString("hex"), kind: "daily_digest", targetUser: "group", entityId: null, to: config.groupId, text: `📋 المهام المتأخرة اليوم (${overdueTasks.length}):\n${lines.join("\n")}${overdueTasks.length > 12 ? "\n…" : ""}` });
  }
  return plans;
}

/** Queue a system notification (to a user id or 'group'); the bridge job delivers it. */
export function enqueueAgentMessage(db: DatabaseSync, input: { toUser: string; text: string }, at: number): string {
  migrateManagementActions(db);
  const id = randomBytes(8).toString("hex");
  db.prepare("INSERT INTO agent_outbox (id,to_user,text,state,created_at) VALUES (?,?,?,'pending',?)").run(id, input.toUser, input.text.slice(0, 3800), at);
  return id;
}

function nextQueued(db: DatabaseSync, config: FollowupConfig, at: number): Planned | null {
  db.prepare("UPDATE agent_outbox SET state='failed' WHERE state='sending' AND created_at<=?").run(at - 5 * 60_000);
  const row = db.prepare("SELECT id,to_user AS toUser,text FROM agent_outbox WHERE state='pending' AND created_at>=? ORDER BY created_at LIMIT 1").get(at - DAY) as { id: string; toUser: string; text: string } | undefined;
  if (!row) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE state='pending' AND created_at<?").run(at - DAY); return null; }
  if (row.toUser === "group") {
    if (!config.groupId || groupBudgetRemaining(db, at) <= 0) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE id=?").run(row.id); return null; }
    return { id: row.id, kind: "daily_digest", targetUser: "group", entityId: null, to: config.groupId, text: row.text };
  }
  const number = config.contacts.find(contact => contact.userId === row.toUser)?.number.replace(/\D/g, "").replace(/^00/, "");
  if (!number) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE id=?").run(row.id); return null; }
  return { id: row.id, kind: "overdue_task", targetUser: row.toUser, entityId: null, to: `${number}@s.whatsapp.net`, text: row.text };
}

export function createFollowupJobs({ db, config, now = Date.now }: { db: DatabaseSync; config: FollowupConfig | (() => FollowupConfig); now?: () => number }) {
  migrateManagementActions(db);
  let running = false;
  const current = () => typeof config === "function" ? config() : config;
  return {
    async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal }) => Promise<unknown>) {
      if (running || !current().enabled) return { status: "idle" as const };
      running = true;
      try {
        const at = now();
        const queued = nextQueued(db, current(), at);
        const plan = queued ?? planFollowups(db, current(), at)[0];
        if (!plan) return { status: "idle" as const };
        // Record first so a crash mid-send never causes a duplicate nudge.
        if (queued) db.prepare("UPDATE agent_outbox SET state='sending' WHERE id=?").run(plan.id);
        db.prepare("INSERT OR REPLACE INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES (?,?,?,?,?,'sending')").run(plan.id, queued ? "queued" : plan.kind, plan.targetUser, plan.entityId, at);
        const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([send({ to: plan.to, text: plan.text, messageId: newMessageId(), signal: controller.signal }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("delivery_uncertain")); }, 15_000); })]);
          db.prepare("UPDATE agent_followups SET response='sent' WHERE id=?").run(plan.id);
          if (queued) db.prepare("UPDATE agent_outbox SET state='sent',sent_at=? WHERE id=?").run(at, plan.id);
          if (plan.kind === "stale_approval") markNudged(db, staleApprovals(db, at, STALE_APPROVAL_AFTER).map(approval => approval.id), at);
          return { status: "sent" as const };
        } catch { db.prepare("UPDATE agent_followups SET response='failed' WHERE id=?").run(plan.id); if (queued) db.prepare("UPDATE agent_outbox SET state='failed' WHERE id=?").run(plan.id); return { status: "failed" as const }; }
        finally { clearTimeout(timeout); }
      } finally { running = false; }
    },
  };
}

