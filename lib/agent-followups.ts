/**
 * Proactive follow-up without spam.
 *  - overdue / silent task   → private message to the task owner, at most once per task per 24h
 *  - stale approvals (>48h)  → private nudge to Basim, at most once per day
 *  - daily digest            → one group message per day (only if something is overdue), inside working hours
 * Uses the same deliverNext(send) contract as secretary-jobs so the bridge drains it identically.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatPendingList, pendingApprovalsPoll, staleApprovals, markNudged } from "./approvals.ts";
import { getManagementSnapshot, migrateManagementActions, type ManagementActor, type ManagementTask } from "./management-actions.ts";
import { GROUP_EVENT_ALLOWLIST, groupBudgetRemaining } from "./team-chat-policy.ts";
import { CHOICE_CANCEL, withWayOut, type SecretaryChoices } from "./secretary-choices.ts";

export type FollowupConfig = { enabled: boolean; contacts: Array<{ userId: string; number: string }>; groupId?: string | null; workStartHour?: number; workEndHour?: number; timezoneOffsetMinutes?: number; publicUrl?: string };
type Planned = { id: string; kind: "overdue_task" | "silent_task" | "stale_approval" | "daily_digest" | "auto_reminder_morning" | "auto_reminder_evening" | "unclaimed_task" | "stale_unclaimed" | "unowned_task"; targetUser: string; entityId: string | null; to: string; text: string; choices?: SecretaryChoices };
// Basim (2026-09-15): every reminder poll used to die an hour after it was
// built, while WhatsApp keeps the bubble tappable forever -- so a tap that
// arrived even slightly late was rejected in total silence
// (poll_not_found_or_consumed, 61 of them in one day on the live bridge) and
// looked to the reader like the bot had simply stopped working. These polls
// carry the task id inside their own option ids, so a late tap still resolves
// to exactly the right task with nothing looked up against live state -- there
// was never a reason for the short window. 24h is the ceiling the bridge
// itself enforces (MAX_POLL_LIFETIME_MS in services/whatsapp-bridge/src/polls.mjs),
// and the same one taskCloseDecisionPoll already uses.
const REMINDER_POLL_LIFETIME_MS = 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000, SILENT_AFTER = 3 * DAY, STALE_APPROVAL_AFTER = 2 * DAY, STALE_UNCLAIMED_AFTER = DAY, HOUR = 60 * 60_000;
// Basim, 2026-09-20: "\u0644\u064a\u0634 \u0627\u0644\u0628\u0648\u062a \u0628\u064a\u0631\u0633\u0644 \u0643\u0644 \u0634\u0648\u064a \u0631\u0633\u0627\u0644\u0647 \u061f" ... "\u0644\u0627 \u062a\u062e\u0644\u064a\u0647 \u064a\u0643\u0631\u0631
// \u0627\u0644\u0631\u0633\u0627\u0644\u0647". These two nudges repeated once an HOUR for as long as a task
// sat unanswered: across the 9-18 window that is nine near-identical messages
// a day, per person, which is how a reminder stops being read at all. Every
// six hours instead -- at most two in a working day, and the task is still
// chased the same day it goes quiet.
const NUDGE_EVERY = 6 * HOUR;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
const clean = (value: string) => value.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);
// Small per-file duplicates of secretary-service.ts's PRIORITIES/LABELS and
// ownerTaskGroups/formatOwnerTaskLines conventions (kept local rather than
// imported, since secretary-service.ts already imports enqueueAgentMessage
// from this file -- importing back from it would be circular).
const PRIORITY_ICON: Record<string, string> = { red: "\ud83d\udd34", yellow: "\ud83d\udfe1", green: "\ud83d\udfe2" };
// Basim (2026-09-12): the same five-command legend he already sees elsewhere
// (TASK_COMMANDS_LEGEND in secretary-service.ts -- duplicated here rather
// than imported, same reason PRIORITY_ICON/STATUS_LABEL are: that file
// already imports enqueueAgentMessage FROM this one), appended directly onto
// the two message kinds he asked for: the "come claim this" nudge and the
// twice-daily digest -- never as a separate follow-up message, just inline
// once at the end. Approved verbatim (see his own "\u0643\u0648\u064a\u0633 \u0637\u0628\u0642" after seeing a
// preview of both messages with this attached).
const TASK_COMMANDS_LEGEND = "\ud83e\udded \u0623\u0648\u0627\u0645\u0631 \u0627\u0644\u0645\u0647\u0627\u0645 \u0627\u0644\u0633\u0631\u064a\u0639\u0629 \u2014 \u0627\u0631\u0633\u0644 \u0627\u0644\u0631\u0642\u0645 \u0645\u0628\u0627\u0634\u0631\u0629:\n\n1\ufe0f\u20e3 \ud83d\udfe2 \u0627\u0636\u0627\u0641\u0629 \u0645\u0647\u0645\u0629\n2\ufe0f\u20e3 \ud83d\udd35 \u0627\u0636\u0627\u0641\u0629 \u0645\u0644\u0627\u062d\u0638\u0629\n3\ufe0f\u20e3 \ud83d\udfe3 \u062a\u062d\u0648\u064a\u0644 \u0627\u0644\u0645\u0647\u0645\u0629\n4\ufe0f\u20e3 \ud83d\udfe0 \u062a\u0645\u062f\u064a\u062f \u0627\u0644\u062a\u0627\u0631\u064a\u062e\n5\ufe0f\u20e3 \ud83d\udd34 \u0627\u0646\u0647\u0627\u0621 \u0627\u0644\u0645\u0647\u0645\u0629";
const STATUS_LABEL: Record<string, string> = { open: "\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645", progress: "\u0642\u064a\u062f \u0627\u0644\u062a\u0646\u0641\u064a\u0630", approval: "\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0639\u062a\u0645\u0627\u062f \u0628\u0627\u0633\u0645" };
function autoReminderGroups(snapshot: { tasks: ManagementTask[] }, userIdByName: Map<string, string>): Map<string, ManagementTask[]> {
  const groups = new Map<string, ManagementTask[]>();
  for (const task of snapshot.tasks) {
    const responsible = task.owner || task.suggestedOwner;
    if (task.archivedAt || task.status === "completed" || !responsible) continue;
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
// Notes under each task, same two-newest rule and same short bound the
// on-demand listings use (taskNotesBlock in secretary-service.ts) -- kept
// local rather than imported for the same reason PRIORITY_ICON/STATUS_LABEL
// are. This reminder is posted to the group as well as privately, which is
// exactly where Basim asked for the notes to show.
type ReminderNote = { taskId: string; author: string; body: string; createdAt: number };
function autoReminderNotes(comments: ReminderNote[], taskId: string): string {
  const notes = comments.filter(comment => comment.taskId === taskId)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 2);
  if (!notes.length) return "";
  return "\n" + notes.map(note => `\u21b3 ${clean(note.author).slice(0, 50)}: ${clean(note.body).slice(0, 70)}`).join("\n");
}
function formatAutoReminderLines(tasks: ManagementTask[], comments: ReminderNote[], today: string): string {
  return reminderBuckets(tasks, today).map(({ label, tasks: bucketed }) => `*${label}*\n` + bucketed.map((task, index) => {
    const suffix = task.dueDate ? ` \u2022 ${clean(task.dueDate)}` : "";
    return `${index + 1}. ${PRIORITY_ICON[task.priority] || "\u26aa"} ${clean(task.title)} \u2014 ${STATUS_LABEL[task.status] || clean(task.status)}${suffix}${autoReminderNotes(comments, task.id)}`;
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
  // Same way out as its twin in secretary-service.ts, and for the same
  // reason -- this one arrives unasked. The >= 2 gate still counts real
  // actions only, so a lone action stays plain text.
  return options.length >= 2 ? { id: `TSKQ${task.id}`, title: "\u0634\u0648 \u0628\u062f\u0643 \u062a\u0639\u0645\u0644 \u0628\u0647\u0627\u0644\u0645\u0647\u0645\u0629\u061f", expiresAt: now + REMINDER_POLL_LIFETIME_MS,
    options: [...options, { id: `${base}NONE`, label: CHOICE_CANCEL }] } : undefined;
}

// Basim (2026-09-12): "قلتلك تيجي تصويت مش هيك نصوص" -- an unowned task (no
// owner AND no suggested owner either) used to nudge him with plain text
// and nothing to tap. Give him a real poll instead, same convention as
// taskActionPoll/autoReminderPoll above: each active employee's name
// assigns the task straight to them (a normal reassign, pending their own
// claim, exactly like naming someone via "عيّنها لـ..." today), and a
// dedicated "تولاها بنفسك" option claims it for Basim directly -- he's
// admin, so a tap resolves this deterministically, see
// parseUnownedTaskPollChoice in secretary-service.ts.
function unownedTaskPoll(taskId: string, users: Array<{ id: string; name: string; active: number }>, ownerId: string, now: number): SecretaryChoices {
  const employees = users.filter(user => user.active !== 0 && user.id !== ownerId).slice(0, 11);
  const options = [...employees.map(user => ({ id: `UNOWN${taskId}_${user.id}`, label: user.name })),
    { id: `UNOWN${taskId}_SELF`, label: "🙋 تولاها بنفسك" }];
  return { id: `UNOWNQ${taskId}`, title: "حددلها موظف مسؤول:", expiresAt: now + REMINDER_POLL_LIFETIME_MS, options };
}
// Basim (2026-09-15): the hourly unclaimed nudge and the overdue/silent nudge
// were both written one-message-per-TASK, each carrying its own poll. Someone
// with five open tasks therefore got five near-identical messages and five
// live polls dumped into their chat in the same minute -- 16 polls went out
// across the team at 09:00 on 2026-09-15 alone ("تصويتات مشطبوكه ببعض").
// One message per PERSON instead, listing their tasks numbered, with ONE poll
// whose options ARE the tasks: the tap picks which task, and the reply to that
// tap carries that task's ordinary action poll (see parseTaskPickerChoice in
// secretary-service.ts). The question id is a constant, so a resend supersedes
// the previous picker bubble server-side and a person never holds two live
// pickers at once. Option ids carry the task id outright, so a tap resolves
// deterministically with nothing looked up against a model -- same convention
// as autoReminderPoll/unownedTaskPoll above.
const TASK_PICKER_LIMIT = 10;
function taskPickerPoll(tasks: ManagementTask[], now: number): SecretaryChoices | undefined {
  if (tasks.length < 2) return undefined;
  // Labels are what a WhatsApp vote is matched against (the bridge hashes the
  // label, see acceptVote), so two tasks sharing a title would make the tap
  // ambiguous and be rejected -- the leading number keeps every label unique
  // and matches the numbering in the message text above the poll.
  const options = tasks.slice(0, TASK_PICKER_LIMIT)
    .map((task, index) => ({ id: `TPK${task.id}`, label: `${index + 1}. ${clean(task.title).slice(0, 86)}` }));
  // This nudge arrives unasked, so the way out matters more here than
  // anywhere: opening a task card is not what someone glancing at a
  // reminder always wants. Ten tasks plus it stays inside WhatsApp's
  // twelve-option limit.
  return { id: "TPKQ", title: "أي مهمة بدك تشتغل عليها؟", expiresAt: now + REMINDER_POLL_LIFETIME_MS,
    options: [...options, { id: "TPKX", label: CHOICE_CANCEL }] };
}
// The numbered list that sits above taskPickerPoll -- same numbering, so "3"
// in the text and the third poll option are the same task.
function pickerLines(tasks: ManagementTask[], comments: ReminderNote[]): string {
  return tasks.slice(0, TASK_PICKER_LIMIT).map((task, index) => {
    const due = task.dueDate ? ` \u2022 ${clean(task.dueDate)}` : "";
    return `${index + 1}. ${PRIORITY_ICON[task.priority] || "\u26aa"} ${clean(task.title)}${due}${autoReminderNotes(comments, task.id)}`;
  }).join("\n");
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
      const lines = formatAutoReminderLines(tasks, snapshot.comments as ReminderNote[], today);
      const number = numberOf(userId);
      if (number && !alreadySent(db, kind, userId, null, at - DAY)) {
        const choices = autoReminderPoll(tasks, user.name, at);
        plans.push({ id: randomBytes(8).toString("hex"), kind, targetUser: userId, entityId: null, to: `${number}@s.whatsapp.net`,
          text: `📋 تذكير بمهامك الحالية يا ${clean(user.name)} (${tasks.length}):\n\n${lines}\n\n${TASK_COMMANDS_LEGEND}`, ...(choices ? { choices } : {}) });
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

  // Basim asked for unclaimed (still "open", never rejected/transferred) tasks
  // to keep nudging their suggested owner every hour, AROUND THE CLOCK (not
  // just during working hours) until they respond in any accepted way --
  // claim it ("استلمت"), or ask to transfer/decline it (which files a pending
  // approval and moves the decision to Basim, so the employee-facing nag
  // stops right away rather than waiting for Basim's decision). Deliberately
  // computed and returned BEFORE the work-hours gate below, same reason the
  // twice-daily auto-reminder block above is. A task with NO suggested owner
  // at all can never be "received" by anyone -- Basim's own follow-up request
  // was to have those come back to him directly instead, same always-on
  // hourly cadence, until he assigns someone. Applies uniformly to old and
  // newly created open tasks alike, since this scans the live snapshot fresh
  // every time rather than tracking task age.
  const ownerNumber = numberOf(owner.id);
  // Collected per PERSON first, then sent as one message + one picker poll --
  // see taskPickerPoll above for why this stopped being one message per task.
  // The dedup key moved with it: (kind, user, null) once an hour, instead of
  // (kind, user, taskId), so a person is nudged about their whole unclaimed
  // pile at most once an hour no matter how often this planner runs.
  const unclaimed = new Map<string, { number: string; name: string; tasks: ManagementTask[] }>();
  for (const task of snapshot.tasks) {
    if (task.archivedAt || task.status !== "open" || task.owner) continue;
    const responsible = task.suggestedOwner;
    if (responsible) {
      const userId = userIdByName.get(responsible); const number = userId ? numberOf(userId) : null;
      if (!userId || !number) continue;
      if (alreadySent(db, "unclaimed_task", userId, null, at - NUDGE_EVERY)) continue;
      if (db.prepare("SELECT id FROM approvals WHERE status='pending' AND entity_id=?").get(task.id)) continue;
      const entry = unclaimed.get(userId) ?? { number, name: responsible, tasks: [] };
      entry.tasks.push(task); unclaimed.set(userId, entry);
    } else if (ownerNumber) {
      if (alreadySent(db, "unowned_task", owner.id, task.id, at - NUDGE_EVERY)) continue;
      // Same resend/supersession hazard as unclaimed_task just above (see its
      // own comment): this nudge repeats hourly while the task stays unowned,
      // and each resend supersedes the previous WhatsApp poll bubble server-side
      // even though WhatsApp itself never marks the old bubble as expired.
      // Basim hit this for real (2026-09-12): he tapped an older "\u062d\u062f\u062f\u0644\u0647\u0627 \u0645\u0648\u0638\u0641
      // \u0645\u0633\u0624\u0648\u0644" bubble and it silently registered his WhatsApp vote client-side
      // while the server rejected it as stale, with no explanation. Spell out
      // which bubble is live, exactly like unclaimed_task already does.
      // Kept one-per-task on purpose: each option in unownedTaskPoll is a
      // different EMPLOYEE, so several tasks cannot share one poll the way
      // taskPickerPoll's task options can.
      const staleNote = "\n\u26a0\ufe0f \u0625\u0630\u0627 \u0641\u064a \u0627\u0633\u062a\u0637\u0644\u0627\u0639 \u062a\u0635\u0648\u064a\u062a \u0623\u0642\u062f\u0645 \u0645\u0646 \u0647\u0630\u0647 \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0644\u0646\u0641\u0633 \u0627\u0644\u0645\u0647\u0645\u0629\u060c \u0647\u0648 \u0645\u0646\u062a\u0647\u064a \u0627\u0644\u0635\u0644\u0627\u062d\u064a\u0629 \u2014 \u0631\u062f \u0645\u0646 \u0627\u0633\u062a\u0637\u0644\u0627\u0639 \u0647\u0630\u0647 \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u062a\u062d\u062f\u064a\u062f\u064b\u0627.";
      plans.push({ id: randomBytes(8).toString("hex"), kind: "unowned_task", targetUser: owner.id, entityId: task.id, to: `${ownerNumber}@s.whatsapp.net`,
        text: `\u26a0\ufe0f \u064a\u0627 \u0628\u0627\u0633\u0645\u060c \u0645\u0647\u0645\u0629 \u00ab${clean(task.title)}\u00bb \u0645\u0627 \u0625\u0644\u0647\u0627 \u0645\u0648\u0638\u0641 \u0645\u0633\u0624\u0648\u0644.${autoReminderNotes(snapshot.comments as ReminderNote[], task.id)}${staleNote}`, choices: unownedTaskPoll(task.id, users, owner.id, at) });
    }
  }
  for (const [userId, entry] of unclaimed) {
    const many = entry.tasks.length > 1;
    const choices = many ? taskPickerPoll(entry.tasks, at) : autoReminderPoll(entry.tasks, entry.name, at);
    const body = many
      ? `\u23f3 \u064a\u0627 ${clean(entry.name)}\u060c \u0639\u0646\u062f\u0643 ${entry.tasks.length} \u0645\u0647\u0627\u0645 \u0644\u0633\u0627 \u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0631\u062f\u0643:\n\n${pickerLines(entry.tasks, snapshot.comments as ReminderNote[])}\n\n\u0627\u0636\u063a\u0637 \u0639\u0644\u0649 \u0627\u0644\u0645\u0647\u0645\u0629 \u0645\u0646 \u0627\u0644\u062a\u0635\u0648\u064a\u062a \u062a\u062d\u062a \u0648\u0628\u064a\u062c\u064a\u0643 \u062e\u064a\u0627\u0631\u0627\u062a\u0647\u0627.`
      : `\u23f3 \u064a\u0627 ${clean(entry.name)}\u060c \u0645\u0647\u0645\u0629 \u00ab${clean(entry.tasks[0].title)}\u00bb \u0644\u0633\u0627 \u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0631\u062f\u0643.${autoReminderNotes(snapshot.comments as ReminderNote[], entry.tasks[0].id)}`;
    plans.push({ id: randomBytes(8).toString("hex"), kind: "unclaimed_task", targetUser: userId, entityId: null, to: `${entry.number}@s.whatsapp.net`,
      text: `${body}\n\n${TASK_COMMANDS_LEGEND}`, ...(choices ? { choices } : {}) });
  }

  if (hour < (config.workStartHour ?? 9) || hour >= (config.workEndHour ?? 18)) return plans;
  const overdueTasks: ManagementTask[] = [];
  // Same per-person collapse the unclaimed nudge above got, and for the same
  // reason: this used to push one message + one poll per task, so a person
  // with several late tasks got a stack of near-identical bubbles. The
  // "one nudge per person per day, never overdue stacked on top of silent"
  // rule that was already intended here is now enforced by the dedup key
  // itself -- (kind, user, null) rather than (kind, user, taskId).
  const nudges = new Map<string, { number: string; name: string; overdue: ManagementTask[]; silent: ManagementTask[] }>();
  for (const task of snapshot.tasks) {
    if (task.archivedAt || ["completed", "approval"].includes(task.status) || !task.owner) continue;
    const userId = userIdByName.get(task.owner); const number = userId ? numberOf(userId) : null;
    if (!userId || !number) continue;
    const overdue = !!task.dueDate && task.dueDate < today;
    const expectedPassed = !!task.expectedAt && task.expectedAt < today;
    const silent = task.status === "progress" && (task.lastUpdateAt ?? task.startedAt ?? task.createdAt) < at - SILENT_AFTER;
    if (overdue) overdueTasks.push(task);
    // One nudge per person per day, whatever its kind: never stack overdue + silent on the same person.
    if (alreadySent(db, "overdue_task", userId, null, at - DAY) || alreadySent(db, "silent_task", userId, null, at - DAY)) continue;
    const entry = nudges.get(userId) ?? { number, name: task.owner, overdue: [], silent: [] };
    if (overdue || expectedPassed) entry.overdue.push(task);
    else if (silent) entry.silent.push(task);
    else continue;
    nudges.set(userId, entry);
  }
  for (const [userId, entry] of nudges) {
    const tasks = [...entry.overdue, ...entry.silent];
    if (!tasks.length) continue;
    const kind = entry.overdue.length ? "overdue_task" as const : "silent_task" as const;
    const choices = tasks.length > 1 ? taskPickerPoll(tasks, at) : autoReminderPoll(tasks, entry.name, at);
    const comments = snapshot.comments as ReminderNote[];
    let text: string;
    if (tasks.length === 1) {
      const task = tasks[0];
      text = kind === "overdue_task"
        ? `\u23f0 \u064a\u0627 ${clean(entry.name)}\u060c \u0645\u0647\u0645\u0629 \u00ab${clean(task.title)}\u00bb \u0643\u0627\u0646 \u0645\u0648\u0639\u062f\u0647\u0627 ${task.dueDate ?? task.expectedAt} \u0648\u0644\u0645 \u062a\u064f\u063a\u0644\u0642 \u0628\u0639\u062f.${autoReminderNotes(comments, task.id)}\n\u0648\u064a\u0646 \u0648\u0635\u0644\u062a\u061f \u0625\u0630\u0627 \u0628\u062f\u0643 \u062a\u0645\u062f\u064a\u062f \u0627\u0636\u063a\u0637 \u00ab\u062a\u0645\u062f\u064a\u062f \u0627\u0644\u062a\u0627\u0631\u064a\u062e\u00bb \u0648\u0627\u062e\u062a\u0627\u0631 \u0627\u0644\u0645\u062f\u0629.`
        : `\ud83d\udc4b \u064a\u0627 ${clean(entry.name)}\u060c \u0645\u0627 \u0648\u0635\u0644\u0646\u064a \u062a\u062d\u062f\u064a\u062b \u0639\u0644\u0649 \u00ab${clean(task.title)}\u00bb \u0645\u0646 3 \u0623\u064a\u0627\u0645.${autoReminderNotes(comments, task.id)}\n\u0648\u064a\u0646 \u0648\u0635\u0644\u062a\u061f \u0623\u0648 \u0633\u062c\u0651\u0644 \u0635\u0648\u062a \u0648\u0623\u0646\u0627 \u0623\u062d\u062f\u0651\u062b\u0647\u0627.`;
    } else {
      const sections = [
        entry.overdue.length ? `*\ud83d\udd34 \u0645\u062a\u0623\u062e\u0631\u0629*\n${pickerLines(entry.overdue, comments)}` : "",
        entry.silent.length ? `*\ud83d\udd4a \u0628\u062f\u0648\u0646 \u062a\u062d\u062f\u064a\u062b*\n${pickerLines(entry.silent, comments)}` : "",
      ].filter(Boolean).join("\n\n");
      text = `\u23f0 \u064a\u0627 ${clean(entry.name)}\u060c ${tasks.length} \u0645\u0647\u0627\u0645 \u0645\u062d\u062a\u0627\u062c\u0629 \u062a\u062d\u062f\u064a\u062b \u0645\u0646\u0643:\n\n${sections}\n\n\u0627\u0636\u063a\u0637 \u0639\u0644\u0649 \u0627\u0644\u0645\u0647\u0645\u0629 \u0645\u0646 \u0627\u0644\u062a\u0635\u0648\u064a\u062a \u062a\u062d\u062a \u0648\u0628\u064a\u062c\u064a\u0643 \u062e\u064a\u0627\u0631\u0627\u062a\u0647\u0627.`;
    }
    plans.push({ id: randomBytes(8).toString("hex"), kind, targetUser: userId, entityId: null, to: `${entry.number}@s.whatsapp.net`,
      text, ...(choices ? { choices } : {}) });
  }
  if (ownerNumber && !alreadySent(db, "stale_approval", owner.id, null, at - DAY)) {
    const stale = staleApprovals(db, at, STALE_APPROVAL_AFTER);
    // The text still spells the decision out in words (formatPendingList's
    // "اكتب «اعتمد 1»"), because the poll can be missed, dismissed or expire --
    // but the poll is what this message is meant to be answered with now.
    if (stale.length) plans.push({ id: randomBytes(8).toString("hex"), kind: "stale_approval", targetUser: owner.id, entityId: null, to: `${ownerNumber}@s.whatsapp.net`, text: `يا باسم، هذه الطلبات معلّقة من أكثر من يومين:\n${formatPendingList(stale)}`, ...(pendingApprovalsPoll(stale, at) ? { choices: pendingApprovalsPoll(stale, at)! } : {}) });
  }
  // Basim's follow-up: the hourly unclaimed_task nudge above only reaches the
  // EMPLOYEE it's suggested to -- he gets no heads-up at all that a task is
  // sitting unclaimed. One private digest a day (never hourly like the
  // employee's own nudge, so it doesn't spam him), listing anything still
  // open/unclaimed a full day after it last changed (updatedAt covers both a
  // fresh add_task and a later reassign -- either way, that's the same
  // moment the employee's own hourly nudge started counting from too).
  // Recomputed fresh from the live snapshot every time, same as the
  // overdue-tasks group digest below, so no separate per-task
  // nudged-tracking table is needed.
  if (ownerNumber && !alreadySent(db, "stale_unclaimed", owner.id, null, at - DAY)) {
    const staleUnclaimed = snapshot.tasks.filter(task => !task.archivedAt && task.status === "open" && !task.owner && task.suggestedOwner
      && (task.updatedAt ?? 0) < at - STALE_UNCLAIMED_AFTER);
    if (staleUnclaimed.length) {
      const lines = staleUnclaimed.map(task => `• ${clean(task.title)} — المقترحة لـ: ${clean(task.suggestedOwner!)}${autoReminderNotes(snapshot.comments as ReminderNote[], task.id)}`);
      plans.push({ id: randomBytes(8).toString("hex"), kind: "stale_unclaimed", targetUser: owner.id, entityId: null, to: `${ownerNumber}@s.whatsapp.net`,
        text: `يا باسم، هذه المهام لسا ما استلمها حدا من أكثر من يوم:\n${lines.join("\n")}` });
    }
  }
  if (config.groupId && overdueTasks.length && !alreadySent(db, "daily_digest", "group", null, at - DAY) && groupBudgetRemaining(db, at) > 0 && GROUP_EVENT_ALLOWLIST.has("delay")) {
    const lines = overdueTasks.slice(0, 12).map(task => `• ${clean(task.title)} — ${task.owner} — ${task.dueDate}${autoReminderNotes(snapshot.comments as ReminderNote[], task.id)}`);
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
  // Every poll carries the universal way out, and every poll sent to a person
  // is remembered as the one they now have open -- see recordOpenChoice.
  const choices = input.toUser !== "group" && input.choices ? withWayOut(input.choices) : null;
  db.prepare("INSERT INTO agent_outbox (id,to_user,text,choices_json,state,created_at) VALUES (?,?,?,?,'pending',?)")
    .run(id, input.toUser, input.text.slice(0, 3800), choices ? JSON.stringify(choices) : null, at);
  if (choices) recordOpenChoice(db, input.toUser, choices);
  return id;
}
/**
 * Remember the poll this person now has open. While it is remembered, the
 * secretary answers nothing they type -- Basim, after Shadi typed "5" at an
 * open poll and closed a task with it: "\u0627\u0644\u063a\u064a \u0643\u0644 \u0627\u0644\u0627\u062d\u062a\u0645\u0627\u0644\u0627\u062a ... \u0648\u0636\u0644\u0643 \u0643\u0631\u0631\u0644\u0647
 * \u064a\u062e\u062a\u0627\u0631 \u062e\u064a\u0627\u0631 \u0641\u0642\u0637 \u0644\u062d\u062f \u0645\u0627 \u064a\u062e\u062a\u0627\u0631 \u0645\u0646 \u0627\u0644\u0642\u0627\u0626\u0645\u0629". The row carries the poll itself, so the
 * reminder can put the same bubble back in front of them rather than pointing
 * at one that has scrolled away.
 */
export function recordOpenChoice(db: DatabaseSync, userId: string, choices: SecretaryChoices): void {
  migrateManagementActions(db);
  if (userId === "group") return;
  db.prepare("INSERT INTO secretary_open_choice (user_id,choices_json,expires_at,nudges) VALUES(?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET choices_json=excluded.choices_json,expires_at=excluded.expires_at,nudges=0")
    .run(userId, JSON.stringify(choices), choices.expiresAt);
}
/** They tapped, or the poll died: either way they are free to type again. */
export function clearOpenChoice(db: DatabaseSync, userId: string): void {
  migrateManagementActions(db);
  db.prepare("DELETE FROM secretary_open_choice WHERE user_id=?").run(userId);
}
export function openChoiceFor(db: DatabaseSync, userId: string, at: number): { choices: SecretaryChoices; nudges: number } | null {
  migrateManagementActions(db);
  const row = db.prepare("SELECT choices_json AS choicesJson,expires_at AS expiresAt,nudges FROM secretary_open_choice WHERE user_id=?")
    .get(userId) as { choicesJson: string; expiresAt: number; nudges: number } | undefined;
  if (!row) return null;
  if (row.expiresAt <= at) { clearOpenChoice(db, userId); return null; }
  try { return { choices: JSON.parse(row.choicesJson) as SecretaryChoices, nudges: row.nudges }; }
  catch { clearOpenChoice(db, userId); return null; }
}
export function countOpenChoiceNudge(db: DatabaseSync, userId: string): void {
  db.prepare("UPDATE secretary_open_choice SET nudges=nudges+1 WHERE user_id=?").run(userId);
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

