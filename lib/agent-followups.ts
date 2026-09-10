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
import type { SecretaryChoices } from "./secretary-choices.ts";

export type FollowupConfig = { enabled: boolean; contacts: Array<{ userId: string; number: string }>; groupId?: string | null; workStartHour?: number; workEndHour?: number; timezoneOffsetMinutes?: number; publicUrl?: string };
type Planned = { id: string; kind: "overdue_task" | "silent_task" | "stale_approval" | "daily_digest" | "auto_reminder_morning" | "auto_reminder_evening" | "unclaimed_task"; targetUser: string; entityId: string | null; to: string; text: string; choices?: SecretaryChoices };
const DAY = 24 * 60 * 60_000, SILENT_AFTER = 3 * DAY, STALE_APPROVAL_AFTER = 2 * DAY, HOUR = 60 * 60_000;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
const clean = (value: string) => value.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);
// Small per-file duplicates of secretary-service.ts's PRIORITIES/LABELS and
// ownerTaskGroups/formatOwnerTaskLines conventions (kept local rather than
// imported, since secretary-service.ts already imports enqueueAgentMessage
// from this file -- importing back from it would be circular).
const PRIORITY_ICON: Record<string, string> = { red: "\ud83d\udd34", yellow: "\ud83d\udfe1", green: "\ud83d\udfe2" };
const STATUS_LABEL: Record<string, string> = { open: "\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645", progress: "\u0642\u064a\u062f \u0627\u0644\u062a\u0646\u0641\u064a\u0630", approval: "\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0639\u062a\u0645\u0627\u062f \u0628\u0627\u0633\u0645" };
function autoReminderGroups(snapshot: { tasks: ManagementTask[]; projects: Array<{ id: string; status: string }> }, userIdByName: Map<string, string>): Map<string, ManagementTask[]> {
  const groups = new Map<string, ManagementTask[]>();
  for (const task of snapshot.tasks) {
    const responsible = task.owner || task.suggestedOwner;
    if (task.archivedAt || task.status === "completed" || !responsible) continue;
    const project = snapshot.projects.find(candidate => candidate.id === task.projectId);
    if (!project || project.status !== "active") continue;
    const userId = userIdByName.get(responsible);
    if (!userId) continue;
    const list = groups.get(userId) || []; list.push(task); groups.set(userId, list);
  }
  return groups;
}
// Basim: "\u0627\u0644\u064a\u0648\u0645 \u0625\u064a\u0634 \u0639\u0646\u062f\u0647 \u0645\u0647\u0627\u0645\u060c \u0628\u0643\u0631\u0629 \u0639\u0646\u062f\u0647 \u0643\u0630\u0627\u060c \u0628\u0639\u062f \u0628\u0643\u0631\u0629 \u0639\u0646\u062f\u0647 \u0643\u0630\u0627\u060c \u0628\u0639\u062f \u0623\u0633\u0628\u0648\u0639
// \u0639\u0646\u062f\u0647 \u0643\u0630\u0627" -- group a person's reminder by when each task is due, with the
// bucket as a heading and its tasks listed underneath, instead of one flat
// numbered list. Plain ISO-date string comparisons, same convention every
// other overdue/due check in this codebase already uses (no real timezone
// math needed once `today` itself was computed with the right offset).
function reminderBuckets(tasks: ManagementTask[], today: string): Array<{ label: string; tasks: ManagementTask[] }> {
  const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  const tomorrow = shift(1), dayAfter = shift(2), weekEnd = shift(7);
  const bucket = (task: ManagementTask) => !task.dueDate ? "\u0628\u062f\u0648\u0646 \u0645\u0648\u0639\u062f \u0645\u062d\u062f\u062f"
    : task.dueDate < today ? "\ud83d\udd34 \u0645\u062a\u0623\u062e\u0631\u0629"
    : task.dueDate === today ? "\u0627\u0644\u064a\u0648\u0645"
    : task.dueDate === tomorrow ? "\u0628\u0643\u0631\u0629"
    : task.dueDate === dayAfter ? "\u0628\u0639\u062f \u0628\u0643\u0631\u0629"
    : task.dueDate <= weekEnd ? "\u062e\u0644\u0627\u0644 \u0623\u0633\u0628\u0648\u0639"
    : "\u0644\u0627\u062d\u0642\u064b\u0627";
  const order = ["\ud83d\udd34 \u0645\u062a\u0623\u062e\u0631\u0629", "\u0627\u0644\u064a\u0648\u0645", "\u0628\u0643\u0631\u0629", "\u0628\u0639\u062f \u0628\u0643\u0631\u0629", "\u062e\u0644\u0627\u0644 \u0623\u0633\u0628\u0648\u0639", "\u0644\u0627\u062d\u0642\u064b\u0627", "\u0628\u062f\u0648\u0646 \u0645\u0648\u0639\u062f \u0645\u062d\u062f\u062f"];
  const groups = new Map<string, ManagementTask[]>();
  for (const task of tasks) { const key = bucket(task); const list = groups.get(key) || []; list.push(task); groups.set(key, list); }
  return order.filter(label => groups.has(label)).map(label => ({ label, tasks: groups.get(label)! }));
}
function formatAutoReminderLines(tasks: ManagementTask[], today: string): string {
  return reminderBuckets(tasks, today).map(({ label, tasks: bucketed }) => `*${label}*\n` + bucketed.map((task, index) => {
    const suffix = task.dueDate ? ` \u2022 ${clean(task.dueDate)}` : "";
    return `${index + 1}. ${PRIORITY_ICON[task.priority] || "\u26aa"} ${clean(task.title)} \u2014 ${STATUS_LABEL[task.status] || clean(task.status)}${suffix}`;
  }).join("\n")).join("\n\n");
}
// Same TSKQ/TSK id scheme as taskActionPoll in secretary-service.ts (a tap
// resolves identically no matter which file built the poll) -- duplicated
// locally rather than imported, same reason PRIORITY_ICON/STATUS_LABEL are:
// secretary-service.ts imports enqueueAgentMessage FROM this file. A
// WhatsApp message carries at most one live poll, so this only attaches one
// when the reminder names exactly one actionable task; with several, the
// employee names the one they mean ("\u062a\u0641\u0627\u0635\u064a\u0644 \u0645\u0647\u0645\u0629 ...") to get its own poll.
function autoReminderPoll(tasks: ManagementTask[], actorName: string, now: number): SecretaryChoices | undefined {
  if (tasks.length !== 1) return undefined;
  const task = tasks[0];
  const base = `TSK${task.id}`;
  const options: Array<{ id: string; label: string }> = [];
  if (task.status === "open" && !task.owner) options.push({ id: `${base}CLAIM`, label: "\ud83d\udc4b \u0627\u0633\u062a\u0644\u0645\u062a \u0627\u0644\u0645\u0647\u0645\u0629" });
  if (task.status === "progress" && task.owner === actorName) options.push({ id: `${base}FINISH`, label: "\u2705 \u062e\u0644\u0635\u062a \u0627\u0644\u0645\u0647\u0645\u0629" }, { id: `${base}NOTE`, label: "\ud83d\udcdd \u0623\u0636\u064a\u0641 \u0645\u0644\u0627\u062d\u0638\u0629" });
  if (task.status === "open" || task.status === "progress") options.push({ id: `${base}TRANSFER`, label: "\ud83d\udd04 \u062d\u0648\u0651\u0644\u0647\u0627 \u0644\u062d\u062f\u0627 \u063a\u064a\u0631\u064a" }, { id: `${base}EDIT`, label: "\ud83d\udd27 \u063a\u064a\u0651\u0631 \u0627\u0644\u0623\u0648\u0644\u0648\u064a\u0629" });
  if (task.status === "progress" && task.owner === actorName) options.push({ id: `${base}EXTEND`, label: "\ud83d\udd50 \u0628\u062f\u064a \u062a\u0645\u062f\u064a\u062f" });
  return options.length >= 2 ? { id: `TSKQ${task.id}`, title: "\u0634\u0648 \u0628\u062f\u0643 \u062a\u0639\u0645\u0644 \u0628\u0647\u0627\u0644\u0645\u0647\u0645\u0629\u061f", expiresAt: now + 60 * 60_000, options } : undefined;
}

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
  const owner = ownerActor(db); if (!owner) return [];
  const numberOf = (userId: string) => config.contacts.find(contact => contact.userId === userId)?.number.replace(/\D/g, "").replace(/^00/, "") ?? null;
  const snapshot = getManagementSnapshot(db, owner);
  const users = snapshot.users as Array<{ id: string; name: string; active: number }>;
  const userIdByName = new Map(users.map(user => [user.name, user.id]));
  const today = localDay(at, offset);
  const plans: Planned[] = [];

  // Twice-daily team task reminder (Basim asked for one at 8am and one at
  // 8pm local, every day) -- deliberately computed and returned BEFORE the
  // work-hours gate below, since both slots sit outside the default 9-18
  // window that gate enforces for the reactive nudges further down.
  const slot = hour === 8 ? "morning" : hour === 20 ? "evening" : null;
  if (slot) {
    const kind = slot === "morning" ? "auto_reminder_morning" : "auto_reminder_evening";
    for (const [userId, tasks] of autoReminderGroups(snapshot, userIdByName)) {
      if (!tasks.length) continue;
      const user = users.find(candidate => candidate.id === userId);
      if (!user) continue;
      const lines = formatAutoReminderLines(tasks, today);
      const number = numberOf(userId);
      if (number && !alreadySent(db, kind, userId, null, at - DAY)) {
        const choices = autoReminderPoll(tasks, user.name, at);
        plans.push({ id: randomBytes(8).toString("hex"), kind, targetUser: userId, entityId: null, to: `${number}@s.whatsapp.net`,
          text: `📋 تذكير بمهامك الحالية يا ${clean(user.name)} (${tasks.length}):\n\n${lines}`, ...(choices ? { choices } : {}) });
      }
      // One group post per owner (never one combined message), same
      // convention as the on-demand "ابعت تذكير المهام الآن" broadcast --
      // entityId here is the owner's id, never null, so different owners'
      // group posts on the same day/slot don't collide under one dedup key.
      if (config.groupId && !alreadySent(db, kind, "group", userId, at - DAY) && groupBudgetRemaining(db, at) > 0) {
        plans.push({ id: randomBytes(8).toString("hex"), kind, targetUser: "group", entityId: userId, to: config.groupId,
          text: `📋 تذكير بالمهام المفتوحة — ${today}\n\n🔴 *${clean(user.name).replace(/\*/g, "")}*\n${lines}` });
      }
    }
  }

  if (hour < (config.workStartHour ?? 9) || hour >= (config.workEndHour ?? 18)) return plans;
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
      const choices = autoReminderPoll([task], task.owner, at);
      plans.push({ id: randomBytes(8).toString("hex"), kind: "overdue_task", targetUser: userId, entityId: task.id, to: `${number}@s.whatsapp.net`,
        text: `⏰ يا ${clean(task.owner)}، مهمة «${clean(task.title)}» كان موعدها ${task.dueDate ?? task.expectedAt} ولم تُغلق بعد.\nوين وصلت؟ إذا بدك تمديد قلّي الموعد الجديد والسبب وأرفعه لباسم.`, ...(choices ? { choices } : {}) });
    } else if (silent && !alreadySent(db, "silent_task", userId, task.id, at - 2 * DAY)) {
      const choices = autoReminderPoll([task], task.owner, at);
      plans.push({ id: randomBytes(8).toString("hex"), kind: "silent_task", targetUser: userId, entityId: task.id, to: `${number}@s.whatsapp.net`,
        text: `👋 يا ${clean(task.owner)}، ما وصلني تحديث على «${clean(task.title)}» من 3 أيام. وين وصلت؟ أو سجّل صوت وأنا أحدّثها.`, ...(choices ? { choices } : {}) });
    }
  }
  // Basim asked for unclaimed (still "open", never rejected/transferred) tasks
  // to keep nudging their suggested owner every hour, during working hours
  // only, until they respond in any accepted way -- claim it ("استلمت"),
  // or ask to transfer/decline it (which files a pending approval and moves
  // the decision to Basim, so the employee-facing nag stops right away
  // rather than waiting for Basim's decision). Applies uniformly to old and
  // newly created open tasks alike, since this scans the live snapshot fresh
  // every time rather than tracking task age.
  for (const task of snapshot.tasks) {
    if (task.archivedAt || task.status !== "open" || task.owner) continue;
    const responsible = task.suggestedOwner;
    if (!responsible) continue;
    const project = snapshot.projects.find(candidate => candidate.id === task.projectId);
    if (!project || project.status !== "active") continue;
    const userId = userIdByName.get(responsible); const number = userId ? numberOf(userId) : null;
    if (!userId || !number) continue;
    if (alreadySent(db, "unclaimed_task", userId, task.id, at - HOUR)) continue;
    if (db.prepare("SELECT id FROM approvals WHERE status='pending' AND entity_id=?").get(task.id)) continue;
    const choices = autoReminderPoll([task], responsible, at);
    plans.push({ id: randomBytes(8).toString("hex"), kind: "unclaimed_task", targetUser: userId, entityId: task.id, to: `${number}@s.whatsapp.net`,
      text: `⏳ يا ${clean(responsible)}، مهمة «${clean(task.title)}» لسا بانتظار ردك.`, ...(choices ? { choices } : {}) });
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

/** Queue a system notification (to a user id or 'group'); the bridge job delivers it.
 * choices, when given, is a real tappable WhatsApp poll to attach alongside the
 * text (see approvalDecisionPoll in approvals.ts) -- 'group' targets ignore it,
 * same as the interactive sendReply path (WhatsApp polls don't work in groups). */
export function enqueueAgentMessage(db: DatabaseSync, input: { toUser: string; text: string; choices?: SecretaryChoices }, at: number): string {
  migrateManagementActions(db);
  const id = randomBytes(8).toString("hex");
  db.prepare("INSERT INTO agent_outbox (id,to_user,text,choices_json,state,created_at) VALUES (?,?,?,?,'pending',?)")
    .run(id, input.toUser, input.text.slice(0, 3800), input.toUser !== "group" && input.choices ? JSON.stringify(input.choices) : null, at);
  return id;
}

function nextQueued(db: DatabaseSync, config: FollowupConfig, at: number): Planned | null {
  db.prepare("UPDATE agent_outbox SET state='failed' WHERE state='sending' AND created_at<=?").run(at - 5 * 60_000);
  const row = db.prepare("SELECT id,to_user AS toUser,text,choices_json AS choicesJson FROM agent_outbox WHERE state='pending' AND created_at>=? ORDER BY created_at LIMIT 1").get(at - DAY) as { id: string; toUser: string; text: string; choicesJson: string | null } | undefined;
  if (!row) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE state='pending' AND created_at<?").run(at - DAY); return null; }
  // A poll expires at most an hour after it was built (approvalDecisionPoll/
  // confirmChoices) -- past that WhatsApp itself would reject it, so drop it
  // here rather than let the bridge attempt and fail; the plain text (which
  // already carries the same choice in words, see APPROVAL_CHOICE_HINT) still
  // goes out normally either way.
  let choices: SecretaryChoices | undefined;
  if (row.choicesJson) { try { const parsed = JSON.parse(row.choicesJson) as SecretaryChoices; if (parsed && parsed.expiresAt > at) choices = parsed; } catch { /* ignore malformed choices */ } }
  if (row.toUser === "group") {
    if (!config.groupId || groupBudgetRemaining(db, at) <= 0) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE id=?").run(row.id); return null; }
    return { id: row.id, kind: "daily_digest", targetUser: "group", entityId: null, to: config.groupId, text: row.text };
  }
  const number = config.contacts.find(contact => contact.userId === row.toUser)?.number.replace(/\D/g, "").replace(/^00/, "");
  if (!number) { db.prepare("UPDATE agent_outbox SET state='failed' WHERE id=?").run(row.id); return null; }
  return { id: row.id, kind: "overdue_task", targetUser: row.toUser, entityId: null, to: `${number}@s.whatsapp.net`, text: row.text, ...(choices ? { choices } : {}) };
}

export function createFollowupJobs({ db, config, now = Date.now }: { db: DatabaseSync; config: FollowupConfig | (() => FollowupConfig); now?: () => number }) {
  migrateManagementActions(db);
  let running = false;
  const current = () => typeof config === "function" ? config() : config;
  return {
    async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal; choices?: SecretaryChoices }) => Promise<unknown>) {
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
          await Promise.race([send({ to: plan.to, text: plan.text, messageId: newMessageId(), signal: controller.signal, ...(plan.choices ? { choices: plan.choices } : {}) }),
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

