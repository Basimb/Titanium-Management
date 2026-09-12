import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeManagementAction, getManagementSnapshot, migrateManagementActions, ManagementActionError, ACTION_KEYS, type ManagementCommand, type ManagementResult } from "./management-actions.ts";
import { resolveChatUser, normalizeContactNumber, type ChatUser } from "./team-chat-policy.ts";
import type { TeamChatConfig, TeamChatEnvelope } from "./team-chat-gateway.ts";
import { directTaskCreationIntent, emptySecretaryIntent, validateSecretaryIntent, type SecretaryIntent, type SecretaryModelInput } from "./secretary-intent.ts";
import { priorityTaskQuery, type PriorityTaskQuery } from "./secretary-priority-query.ts";
import { AGENT_KINDS } from "./secretary-intent.ts";
import { applyDecision, createTasks, handleAgentIntent, type AgentResult, type TaskDraftTask } from "./secretary-agent.ts";
import { listApprovals, requestTaskCreate } from "./approvals.ts";
import { activeRules } from "./rules.ts";
import { searchKnowledge, formatKnowledgeHits } from "./knowledge.ts";
import { migrateSecretaryMemory, rememberSecretaryMistake, recallSecretaryMemory, personalMemoryCommand, updatePersonalMemory, personalMemory } from "./secretary-memory.ts";
import { enqueueAgentMessage } from "./agent-followups.ts";
import { safeConversationalReply } from "./secretary-conversation-policy.ts";
import { secretaryReviewRequest, isSecretaryIdentityQuery, isAddressedToSecretary, SECRETARY_IDENTITY } from "./secretary-review.ts";
import { migrateSecretaryOutbox, getSecretaryOutboxRecipients, createSecretaryOutboxPreview, confirmSecretaryOutboxPreview, getSecretaryOutboxStatus, secretaryOutboxDeliveryLabel, SecretaryOutboxError } from "./secretary-outbox.ts";
import { migrateSecretaryChoices, createSecretaryChoices, consumeSecretaryChoice, clearSecretaryChoices, secretaryChoiceOptions, peekSecretaryChoiceField, SecretaryChoiceError, type SecretaryChoices, type SecretaryChoiceField } from "./secretary-choices.ts";

type Task = { id: string; title: string; details: string; status: string; priority: string; owner: string | null; suggestedOwner: string | null; dueDate: string | null; updatedAt: number | null; archivedAt: number | null };
export type Snapshot = { tasks: Task[]; users: Array<ChatUser>; comments: Array<{ taskId: string; author: string; body: string; createdAt: number }> };
type Event = TeamChatEnvelope & { replyToMessageId?: string | null; responseMessageId?: string | null };
type Result = { status: string; reply: string; taskId?: string; batchId?: string; choices?: SecretaryChoices };
type Pending = { token: string; command_json: string; snapshot_hash: string; original_text: string; source_message_id: string; expires_at: number };
// A typed close_request/task_transfer_request/comment/submit whose OWN task
// turned out ambiguous (see legendCandidates reuse below) -- holds just
// enough of the original command to finish it once a poll tap names which
// task, mirroring secretary_pending's shape but keyed to a task CHOICE
// instead of a yes/no confirmation.
type TaskChoiceRow = { token: string; kind: string; candidate_ids: string; fields_json: string; original_text: string; source_message_id: string; expires_at: number };
type ConfirmationView = { token: string; preview_event_key: string; requires_restatement: number };
type HistoryRow = { original_text: string; result_json: string; scope_json: string };
type TaskDraft = { title: string | null; details: string | null; priority: "red" | "yellow" | "green" | null; ownerId: string | null; dueDate: string | null };
type IntakeRow = { draft_json: string; last_event_key: string; expires_at: number };
const ORIGIN = "https://www.management.titanium-pharmacy.com";
const CONFIRM_MS = 10 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const HISTORY_CHARS = 6000;
const INTAKE_MS = 30 * 60_000;
const SENSITIVE = new Set(["edit_task", "cancel_claim", "submit", "approve", "reject", "reopen", "reassign", "archive_task", "restore_task", "delete_task"]);
// Basim's "شرح الأوامر" footer, redesigned into a numbered 1-5 quick menu per
// his own explicit request ("اضافة مهمه ارسل رقم 1 و..."): a short standalone
// reminder of the five WhatsApp actions an EMPLOYEE (never Basim -- he
// doesn't need this) can trigger about a task, sent as a SEPARATE follow-up
// message right after any task-related message reaches that employee. Each
// line carries a colored circle purely for quick visual scanning (no meaning
// tied to the color itself, unlike the priority icons elsewhere). Sending the
// bare digit works exactly like tapping the matching option in
// taskCommandsLegendPoll below -- see legendDigitOptionId's own comment for
// why a bare digit only resolves this way sometimes.
const TASK_COMMANDS_LEGEND = "🧭 أوامر المهام السريعة — ارسل الرقم مباشرة:\n\n1️⃣ 🟢 اضافة مهمة\n2️⃣ 🔵 اضافة ملاحظة\n3️⃣ 🟣 تحويل المهمة\n4️⃣ 🟠 تمديد التاريخ\n5️⃣ 🔴 انهاء المهمة";
// Basim: "بدي هذه تتحول تصويت للكل وفي كل مكان" -- the legend above is plain
// text everywhere it's sent, so attach a poll alongside it (same trick as
// resolveTaskActionTextChoice's NOTE/TRANSFER/EDIT/EXTEND below) whose four
// options are just the exact bare command phrases the legend already tells
// people to type. A tap is rewritten to that literal text, once, at the very
// top of the pipeline (resolveTaskCommandsLegendChoice), then falls through
// the SAME existing handling a person typing it themselves already gets --
// no new task-resolution logic, since these commands are already generic
// (not bound to one task) exactly like their typed form is today. Unlike
// taskActionPoll (bound to one task's id in its option ids), this poll is
// identical everywhere it's attached, so it needs no task/actor context.
function taskCommandsLegendPoll(now: number): SecretaryChoices {
  return { id: "LGDQ", title: "🧭 أو اضغط أي أمر مباشرة:", expiresAt: now + 60 * 60_000, options: [
    { id: "LGDADD", label: "1️⃣ 🟢 اضافة مهمة" }, { id: "LGDNOTE", label: "2️⃣ 🔵 اضافة ملاحظة" },
    { id: "LGDTRANSFER", label: "3️⃣ 🟣 تحويل المهمة" }, { id: "LGDEXTEND", label: "4️⃣ 🟠 تمديد التاريخ" },
    { id: "LGDFINISH", label: "5️⃣ 🔴 انهاء المهمة" }] };
}
// Candidate tasks for one of the legend's FINISH/TRANSFER/NOTE options,
// using the exact same eligibility taskActionPoll already applies for a
// task-bound tap -- this poll just isn't bound to one task, so this counts
// candidates itself instead of trusting a task id encoded in the option.
function legendCandidates(state: Snapshot, actorName: string, optionId: string): Task[] {
  return state.tasks.filter(task => !task.archivedAt && (optionId === "LGDTRANSFER"
    ? (task.status === "open" || task.status === "progress") && (task.owner || task.suggestedOwner) === actorName
    : task.status === "progress" && task.owner === actorName));
}
const LEGEND_NO_TASK: Record<string, string> = {
  LGDFINISH: "ما عندك مهمة قيد التنفيذ حاليًا لإنهائها.",
  LGDNOTE: "ما عندك مهمة قيد التنفيذ حاليًا لإضافة ملاحظة عليها.",
  LGDTRANSFER: "ما عندك مهمة مفتوحة أو قيد التنفيذ حاليًا لتحويلها.",
};
// LGDEXTEND deliberately isn't in the map above: an extension always needs a
// new date the person hasn't given yet, so unlike FINISH/NOTE/TRANSFER's
// zero/multiple-candidate cases it never enters the deterministic
// taskChoicePoll branch below (see resolveTaskCommandsLegendChoice) --
// zero/several eligible tasks both just fall back to the plain, already-
// working "بدي أمدد موعد مهمة" sentence, which the normal model-driven flow
// already knows how to ask a clarifying "أي مهمة؟" about on its own.
const LEGEND_MANY_TASK = "عندك أكثر من مهمة تنطبق، أي وحدة بالضبط؟";
// Basim: typing "انهاء المهمة"/"تحويل المهمة"/"اضافة ملاحظة" (close_request/
// task_transfer_request/comment, below) without clearly naming which task let
// the model silently guess one of several eligible tasks on its own -- "على
// الاغلب البوت بيختار اول مهمه قيد التفيذ". legendCandidates already solves
// exactly this ambiguity for the TAPPED legend reminder (auto-resolve a
// single candidate, otherwise ask); this poll is the same idea applied to a
// person's own TYPED command instead of a stale model guess: a real tappable
// choice among the SAME eligible tasks, holding the rest of that command
// (a note's text, a transfer's target owner, ...) in secretary_task_choice
// until the tap says which task it was about all along.
function taskChoicePoll(token: string, candidates: Task[], now: number): SecretaryChoices {
  return { id: `TDQ${token}`, title: LEGEND_MANY_TASK, expiresAt: now + CONFIRM_MS,
    options: candidates.map((task, index) => ({ id: `TDQ${token}_${index}`, label: clean(task.title, 90) })) };
}
function parseTaskChoicePollChoice(event: Event): { token: string; index: number } | null {
  const choice = event.choice;
  if (!choice || !choice.questionId.startsWith("TDQ")) return null;
  const token = choice.questionId.slice(3);
  if (!/^[0-9A-F]{6}$/.test(token)) return null;
  const match = new RegExp(`^TDQ${token}_(\\d+)$`).exec(choice.optionId);
  return match ? { token, index: Number(match[1]) } : null;
}
function legendRewriteText(optionId: string, title: string): string {
  return optionId === "LGDFINISH" ? `خلصت مهمة «${title}»`
    : optionId === "LGDNOTE" ? `بدي أضيف ملاحظة على مهمة «${title}»`
    : optionId === "LGDEXTEND" ? `بدي أمدد موعد مهمة «${title}»`
    : `بدي أحول مهمة «${title}» لحدا غيري`;
}
// Basim: "خلصت المهمة"/"حوّل المهمة"/"بدي أضيف ملاحظة" typed out on their
// own, without ever tapping the legend poll, must resolve exactly as
// deterministically as a real tap does -- a typed "انهاء المهمة" reaching
// the model as plain conversation is what let it silently guess a taskId on
// its own (or bail out to a generic "clarify") instead of ever offering a
// real tappable choice among several eligible tasks: خالد's case, the same
// broken numbered-list reply came back twice in a row for the same message.
// Matches the WHOLE normalized message on purpose, same as every other
// bare-command check in this file (bareOwnershipOrdinal, directTaskList) --
// a longer sentence that merely mentions one of these words is left alone
// for the model exactly as before.
//
// Basim tested this himself right after it first shipped and it MISSED his
// own messages ("انهاء مهمه", "انهيت مهمه", "خلصت مهمه") -- casual WhatsApp
// typing routinely drops the definite article ("مهمة" instead of "المهمة")
// and spells the tied-ta as a plain ه ("مهمه" instead of "مهمة"), and the
// first version of this list only matched the fully-spelled formal forms.
// legendTypedPhraseOption below now folds ة to ه before matching (so
// "المهمة" and "مهمه" compare equal) and every pattern makes the "ال"
// article optional, so the phrase list only needs to spell the ه form once.
const LEGEND_TYPED_PHRASES: Record<string, RegExp> = {
  LGDFINISH: /^(?:انهاء (?:ال)?مهمه|انهيت (?:ال)?مهمه|خلصت (?:ال)?مهمه|خلصت من (?:ال)?مهمه|خلصت مهمتي|خلصتها|انتهيت من (?:ال)?مهمه|انتهيت منها)$/,
  LGDTRANSFER: /^(?:تحويل (?:ال)?مهمه|حول (?:ال)?مهمه|حولها لحدا غيري|حولها لشخص غيري|مش مسؤوليتي|ما بقدر اعملها|ما بقدر اسويها)$/,
  LGDNOTE: /^(?:اضافه (?:ال)?ملاحظه|بدي اضيف ملاحظه|بدي اضيف تحديث|عندي تحديث|بدي احدث (?:ال)?مهمه)$/,
  LGDEXTEND: /^(?:تمديد (?:ال)?تاريخ|تمديد (?:ال)?موعد|بدي امدد (?:ال)?موعد|مدد (?:ال)?موعد|تمديد (?:ال)?مهمه)$/,
};
function legendTypedPhraseOption(text: string): string | null {
  const normalized = text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[ً-ٰٟـ؟?!.،,]/g, "").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
  for (const optionId of Object.keys(LEGEND_TYPED_PHRASES)) if (LEGEND_TYPED_PHRASES[optionId].test(normalized)) return optionId;
  return null;
}
// Basim's own wording for the numbered menu ("اضافة مهمه ارسل رقم 1"...
// "كل ما يضغط رقم يطلعلو التصويت المناسب") -- a bare typed digit "1".."5"
// mirrors the same five options taskCommandsLegendPoll offers, so someone
// who types the digit instead of tapping the poll option still lands on the
// exact same result. Deliberately narrower than legendTypedPhraseOption's
// word phrases above: a bare 1-3 digit number is ALREADY a heavily-tested,
// deterministic shortcut for picking a task straight off a just-shown "شو
// مهامي؟" list by its position (bareOwnershipOrdinal, further down this
// file, keyed on ownershipCandidates) -- rewriting "1" here unconditionally
// would silently hijack that picker (typing "1" to open task #1 would
// instead start "اضافة مهمة" every time). resolveTaskCommandsLegendChoice
// below only ever treats a bare digit this way once it has confirmed
// ownershipCandidates is empty for that actor -- i.e. only when there is no
// task at all for the ordinal picker to compete over. Everyone else still
// has two fully collision-free ways to reach the same five actions: tapping
// the real poll option (a WhatsApp vote, never confused with typed text) or
// typing the full phrase above (LEGEND_TYPED_PHRASES) -- neither of which
// bareOwnershipOrdinal's purely-numeric regex ever matches.
const LEGEND_DIGIT_OPTIONS: Record<string, string> = { "1": "LGDADD", "2": "LGDNOTE", "3": "LGDTRANSFER", "4": "LGDEXTEND", "5": "LGDFINISH" };
function legendDigitOptionId(text: string): string | null {
  const normalized = text.normalize("NFKC").replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0)).replace(/[\s.!؟?]+$/u, "").trim();
  return LEGEND_DIGIT_OPTIONS[normalized] ?? null;
}
// Basim: the model itself sometimes gives up with a plain "which task"
// clarify for a short private message that plainly names one of the same
// three self-service actions by a bare keyword, without matching one of
// LEGEND_TYPED_PHRASES' own exact wordings above (his own report: "ضيف
// ملاحظه", not "بدي اضيف ملاحظة"). Unlike legendTypedPhraseOption, this is
// ONLY ever consulted after the model already tried and answered "clarify"
// on its own (see the call site in handleSecretaryEvent) -- it never
// pre-empts the model, so a message the model resolved some other way, or
// asked its own more specific question about, never reaches this at all.
// Bounded to a short, non-negated message so a longer sentence that only
// mentions one of these words in passing keeps whatever the model already
// asked about it.
const LEGEND_FUZZY_KEYWORDS: Record<string, RegExp> = {
  LGDFINISH: /(?:^| )(?:خلص|خلصت|خلصنا|انهيت|انتهيت|سكرت|سكرها)(?:$| )/,
  LGDTRANSFER: /(?:^| )(?:حول|تحويل|حولها)(?:$| )/,
  LGDNOTE: /(?:^| )(?:ملاحظه|تحديث|تعليق)(?:$| )/,
  LGDEXTEND: /(?:^| )(?:تمديد|مدد|تأجيل|اجل)(?:$| )/,
};
function legendFuzzyPhraseOption(text: string): string | null {
  const normalized = text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[ً-ٰٟـ؟?!.،,]/g, "").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.split(" ").length > 8 || /(?:^| )(?:ما|مو|مش|لا|لم|لن)(?:$| )/.test(normalized)) return null;
  for (const optionId of Object.keys(LEGEND_FUZZY_KEYWORDS)) if (LEGEND_FUZZY_KEYWORDS[optionId].test(normalized)) return optionId;
  return null;
}
// Inverse of taskCommandsLegendPoll. LGDADD is always safe to rewrite
// outright -- a brand-new task touches no existing record. FINISH/TRANSFER/
// NOTE need an existing task identified first: unlike taskActionPoll's own
// taps (bound to the one task the poll was sent about), this poll carries no
// task id, so naively rewriting to the bare command let the model quietly
// guess among the actor's OTHER tasks instead of asking -- exactly what
// happened to Basim: a FINISH tap on a brand-new, still-unclaimed task
// resolved instead to a completely different task he already had in
// progress. Resolve deterministically here only when exactly one of the
// actor's own tasks could apply to that action; otherwise leave event.choice
// set so the dedicated branch in handleSecretaryEvent asks by name instead
// of ever letting the model guess. Also runs for a typed phrase that never
// touched the poll at all (legendTypedPhraseOption above), synthesizing the
// same LGDQ choice shape so a typed command converges onto the exact same
// resolution as a tap -- including its own dedicated branch below for the
// 0/2+ leftover cases.
function resolveTaskCommandsLegendChoice(db: DatabaseSync, event: Event, config: TeamChatConfig, now: number): Event {
  const isBareCommand = !event.choice && event.groupId === null && !event.replyToMessageId && event.inputKind !== "voice";
  const typedOptionId = isBareCommand ? legendTypedPhraseOption(event.text) : null;
  const digitOptionId = isBareCommand && !typedOptionId ? legendDigitOptionId(event.text) : null;
  // Only fetched/used when a bare digit might apply -- see legendDigitOptionId's
  // own comment for why an employee's typed "1".."5" must confirm
  // ownershipCandidates is empty before preempting the ordinal task picker.
  // Basim himself is exempt from that check, per his own explicit request
  // (2026-09-12): bareOwnershipOrdinal already never fires for him (line
  // ~1493, unconditionally excludes basem/admin), so there is no ordinal
  // picker for a bare digit to collide with in his own chat -- his "1".."5"
  // should always reach the same five actions, exactly like an employee with
  // zero tasks. The multi-candidate case (e.g. "2" with several of his own
  // open tasks) already has a real tappable poll waiting for it further
  // down (the legendChoice branch, ~line 1130) -- that branch was never
  // itself gated on identity, only this bare-digit entry point was.
  const digitActor = digitOptionId ? actorFor(db, event, config) : null;
  const digitIsSafe = digitOptionId !== null && digitActor !== null
    && (digitActor.id === "basem" || digitActor.role === "admin"
      ? true
      : ownershipCandidates(stateFor(db, digitActor), now).length === 0);
  const choice = event.choice ?? (typedOptionId ? { questionId: "LGDQ", optionId: typedOptionId }
    : digitIsSafe ? { questionId: "LGDQ", optionId: digitOptionId as string } : undefined);
  if (!choice || choice.questionId !== "LGDQ") return event;
  if (choice.optionId === "LGDADD") return { ...event, text: "اضافة مهمة", choice: undefined };
  if (!["LGDFINISH", "LGDTRANSFER", "LGDNOTE", "LGDEXTEND"].includes(choice.optionId)) return event;
  const actor = digitActor ?? actorFor(db, event, config);
  if (!actor) return { ...event, choice: undefined };
  const candidates = legendCandidates(stateFor(db, actor), actor.name, choice.optionId);
  if (candidates.length === 1) return { ...event, text: legendRewriteText(choice.optionId, candidates[0].title), choice: undefined };
  // LGDEXTEND never carries the leftover `choice` forward (unlike FINISH/
  // TRANSFER/NOTE just below) -- see LEGEND_NO_TASK's own comment for why an
  // extension can't reuse that deterministic multi-candidate poll machinery.
  if (choice.optionId === "LGDEXTEND") return { ...event, text: "بدي أمدد موعد مهمة", choice: undefined };
  return { ...event, choice };
}
/** Queues the command legend as its own WhatsApp message (never in the same
 * bubble as the task message itself) for a real employee recipient only --
 * never for Basim and never for the group. Call this right alongside every
 * task-related message/notice an employee receives, per Basim's request.
 *
 * withPoll=false sends the legend as plain text only, no attached poll.
 * The WhatsApp bridge (polls.mjs sendQuestion) treats a poll as one-per-
 * phone-number: sending ANY new poll to a sender immediately supersedes
 * (invalidates the tap-ability of) whatever poll was still live for that
 * same sender, even one sent a moment earlier for an unrelated purpose --
 * a deliberate anti-replay guard, not a bug in that file. Basim hit this
 * for real: reassigning him a task queues a task-specific CLAIM/TRANSFER/
 * EDIT poll to the new owner, and this legend used to follow it one
 * millisecond later as a SECOND poll to that same person -- silently
 * killing the CLAIM poll's tap-ability (or its WhatsApp-side delivery
 * retry) before he ever got to tap it, so "استلمت المهمة" never appeared
 * to actually work. Callers that already attached a task-specific poll to
 * the message the employee just received must pass withPoll=false here so
 * the legend never competes with it -- the legend's own commands mostly
 * overlap that poll's options anyway (TRANSFER/EDIT), and the plain-text
 * reminder is still enough to point them at "اضافة مهمة" for anything the
 * task poll doesn't cover. */
function notifyTaskLegend(db: DatabaseSync, toUser: string, now: number, withPoll = true) {
  if (toUser === "basem" || toUser === "group") return;
  enqueueAgentMessage(db, { toUser, text: TASK_COMMANDS_LEGEND, ...(withPoll ? { choices: taskCommandsLegendPoll(now) } : {}) }, now);
}
// Basim: don't display a completed task's status as "معتمدة" (approved) --
// display "مكتملة" (completed) instead. Same underlying status value
// ("completed"), just the word shown for it everywhere a task's status is
// rendered (task cards, report headers, the TV board).
const LABELS: Record<string, string> = { open: "بانتظار الاستلام", progress: "قيد التنفيذ", approval: "بانتظار اعتماد باسم", completed: "مكتملة" };
const ACTION_LABELS: Record<string, string> = { add_task: "إنشاء مهمة", edit_task: "تعديل المهمة", claim: "استلام المهمة", cancel_claim: "إرجاع المهمة", comment: "إضافة تعليق", submit: "إرسال المهمة لاعتماد باسم", approve: "اعتماد إنجاز المهمة", reject: "رفض الإنجاز", reopen: "إعادة فتح المهمة", reassign: "تغيير المسؤول", archive_task: "أرشفة المهمة", restore_task: "استعادة المهمة", delete_task: "حذف المهمة نهائيًا" };
const clean = (value: unknown, max = 200) => String(value ?? "").replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
// Seed content for secretary_playbook (id='main') -- the standing team
// instructions retrievable on demand by anyone sending the exact phrase
// "\u062a\u0639\u0644\u064a\u0645\u0627\u062a \u0627\u0644\u0633\u0643\u0631\u062a\u064a\u0631". This mirrors the announcement Basim approved and had
// posted to the team group; DEFAULT_PLAYBOOK only seeds a fresh row (INSERT
// OR IGNORE), it never overwrites a value Basim already edited via the
// admin-only update command.
const DEFAULT_PLAYBOOK = `\ud83d\udccc \u062a\u0639\u0644\u064a\u0645\u0627\u062a \u0645\u0647\u0645\u0629 \u0644\u0643\u0644 \u0627\u0644\u0641\u0631\u064a\u0642:

\u0623\u0648\u0644 \u0634\u064a: \u0627\u0628\u0639\u062a\u0648\u0644\u064a \u0631\u0633\u0627\u0644\u0629 (\u0648\u0644\u0648 \u0628\u0633 \u0643\u0644\u0645\u0629 "\u0645\u0631\u062d\u0628\u0627") \u0639\u0644\u0649 \u0627\u0644\u062e\u0627\u0635 \u0647\u0648\u0646\u060c \u0645\u0634\u0627\u0646 \u062a\u0646\u0641\u062a\u062d \u0642\u0646\u0627\u0629 \u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0628\u064a\u0646\u064a \u0648\u0628\u064a\u0646\u0643\u0645 \u0648\u062a\u0648\u0635\u0644\u0643\u0645 \u0631\u0633\u0627\u064a\u0644\u064a \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0639\u062f\u064a\u0646. \u0623\u0646\u0627 \u0628\u0633\u062a\u0646\u0627\u0647\u0627 \u0645\u0646\u0643\u0645.

1) \u0644\u0645\u0627 \u0628\u0627\u0633\u0645 \u064a\u0641\u062a\u062d \u0645\u0634\u0631\u0648\u0639 \u0648\u064a\u062d\u0637 \u0645\u0647\u0645\u0629 \u0625\u0644\u0643\u060c \u0631\u062d \u062a\u0648\u0635\u0644\u0643 \u0631\u0633\u0627\u0644\u0629 \u062e\u0627\u0635\u0629 (\ud83c\udd95 \u0645\u0647\u0645\u0629 \u062c\u062f\u064a\u062f\u0629) \u2014 \u0647\u0627\u064a \u0645\u0642\u062a\u0631\u062d\u0629 \u0625\u0644\u0643 \u0648\u0628\u0633\u062a\u0646\u0649 \u0645\u0648\u0627\u0641\u0642\u062a\u0643. \u0644\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0648\u0627\u0644\u0628\u062f\u0621\u060c \u0627\u0643\u062a\u0628\u0644\u064a \u0628\u0633 \u00ab\u0627\u0633\u062a\u0644\u0645\u062a \u0627\u0644\u0645\u0647\u0645\u0629\u00bb \u0623\u0648 \u0627\u0630\u0643\u0631 \u0631\u0642\u0645\u0647\u0627.

2) \u0628\u0627\u0644\u0646\u0633\u0628\u0629 \u0644\u0645\u0647\u0627\u0645\u0643\u0645 \u0627\u0644\u062d\u0627\u0644\u064a\u0629: \u0644\u0648 \u0641\u064a \u0645\u0647\u0645\u0629 \u062d\u0627\u0633\u064a\u0646 \u0625\u0646\u0647\u0627 \u0645\u0648 \u0627\u0644\u0635\u062d \u0625\u0644\u0643\u0645 \u0623\u0648 \u0641\u064a\u0647\u0627 \u062e\u0637\u0623\u060c \u0631\u0627\u0633\u0644\u0648\u0646\u064a \u0639\u0644\u0649 \u0627\u0644\u062e\u0627\u0635 \u0648\u0627\u0630\u0643\u0631\u0648\u0627 \u0631\u0642\u0645 \u0627\u0644\u0645\u0647\u0645\u0629 \u0648\u0633\u0628\u0628 \u0637\u0644\u0628 \u0627\u0644\u062a\u062d\u0648\u064a\u0644\u060c \u0648\u0628\u062a\u0627\u0628\u0639\u0647\u0627 \u0645\u0639 \u0628\u0627\u0633\u0645. \u0644\u0648 \u0645\u0627 \u0631\u0627\u0633\u0644\u062a\u0648\u0646\u064a\u060c \u0628\u062a\u0636\u0644 \u0627\u0644\u0645\u0647\u0645\u0629 \u0639\u0644\u064a\u0643\u0645 \u0645\u062a\u0644 \u0645\u0627 \u0647\u064a.

3) \u0644\u062a\u062d\u0648\u064a\u0644 \u0645\u0647\u0645\u0629 \u0644\u0634\u062e\u0635 \u062b\u0627\u0646\u064a\u060c \u0623\u0648 \u0644\u0648 \u0645\u0627 \u0628\u062a\u0642\u062f\u0631\u0648\u0627 \u062a\u0643\u0645\u0644\u0648\u0647\u0627 \u0648\u0628\u062f\u0643\u0645 \u062a\u0631\u062c\u0639\u0648\u0647\u0627\u060c \u0623\u0648 \u0644\u0625\u0646\u0647\u0627\u0621 \u0645\u0647\u0645\u0629 (\u062e\u0644\u0635\u062a\u0648\u0647\u0627): \u0631\u0627\u0633\u0644\u0648\u0646\u064a \u0639\u0644\u0649 \u0627\u0644\u062e\u0627\u0635 \u0648\u0627\u0630\u0643\u0631\u0648\u0627 \u0631\u0642\u0645 \u0627\u0644\u0645\u0647\u0645\u0629 (\u0645\u062a\u0644 \u0645\u0627 \u0647\u0648 \u0645\u0643\u062a\u0648\u0628 \u0628\u0642\u0627\u0626\u0645\u0629 \u0645\u0647\u0627\u0645\u0643\u0645) \u0648\u0634\u0648 \u0628\u062f\u0643\u0645 \u0628\u0627\u0644\u0636\u0628\u0637.

\u0643\u0644 \u0647\u0627\u0644\u062d\u0627\u0644\u0627\u062a \u062a\u0643\u0648\u0646 \u0628\u0631\u0633\u0627\u0644\u0629 \u062e\u0627\u0635\u0629 \u0625\u0644\u064a \u0645\u0634 \u0647\u0648\u0646 \u0639\u0627\u0644\u062c\u0631\u0648\u0628\u060c \u0648\u0623\u0646\u0627 \u0628\u0639\u0644\u0646 \u0622\u062e\u0631 \u062a\u062d\u062f\u064a\u062b \u0647\u0648\u0646 \u0639\u0627\u0644\u062c\u0631\u0648\u0628 \u0623\u0648\u0644 \u0645\u0627 \u062a\u0646\u062d\u0633\u0645.

4) \u0631\u062d \u062a\u0648\u0635\u0644\u0643\u0645 \u062a\u0630\u0643\u064a\u0631 \u062a\u0644\u0642\u0627\u0626\u064a \u0628\u0645\u0647\u0627\u0645\u0643\u0645 \u0645\u0631\u062a\u064a\u0646 \u0643\u0644 \u064a\u0648\u0645\u060c \u0627\u0644\u0633\u0627\u0639\u0629 8 \u0627\u0644\u0635\u0628\u062d \u06488 \u0627\u0644\u0645\u0633\u0627.

\u0648\u0644\u0648 \u062d\u0628\u064a\u062a\u0648\u0627 \u062a\u0631\u0627\u062c\u0639\u0648\u0627 \u0647\u0627\u0644\u062a\u0639\u0644\u064a\u0645\u0627\u062a \u0628\u0623\u064a \u0648\u0642\u062a\u060c \u0627\u0643\u062a\u0628\u0648\u0644\u064a \u00ab\u062a\u0639\u0644\u064a\u0645\u0627\u062a \u0627\u0644\u0633\u0643\u0631\u062a\u064a\u0631\u00bb \u0648\u0628\u0639\u0631\u0636\u0647\u0627 \u0625\u0644\u0643\u0645 \u0645\u0646 \u062c\u062f\u064a\u062f.

\u0646\u0633\u0623\u0644 \u0627\u0644\u0644\u0647 \u0627\u0644\u062a\u0648\u0641\u064a\u0642 \u0645\u0639 \u0628\u0639\u0636`;
// Arabic count agreement for "\u0645\u0647\u0645\u0629" -- 1 and 2 have their own words, 3-10
// take the plural, 11+ reverts to the singular after the number.
const taskCountPhrase = (n: number) => n === 1 ? "\u0645\u0647\u0645\u0629 \u0648\u0627\u062d\u062f\u0629" : n === 2 ? "\u0645\u0647\u0645\u062a\u064a\u0646" : n <= 10 ? `${n} \u0645\u0647\u0627\u0645` : `${n} \u0645\u0647\u0645\u0629`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conversation = (event: Event, actor: ChatUser) => hash([normalizeContactNumber(event.senderNumber), event.groupId, actor.id]);
const eventKey = (event: Event) => hash([event.senderNumber, event.groupId, event.messageId]);
const eventHash = (event: Event) => hash([event.senderNumber, event.groupId, event.text, event.replyToMessageId ?? null, event.responseMessageId ?? null, event.inputKind || "text", ...(event.choice ? [event.choice] : [])]);
function transaction<T>(db: DatabaseSync, work: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
export function migrateSecretary(db: DatabaseSync) {
  migrateSecretaryMemory(db);
  migrateManagementActions(db);
  migrateSecretaryOutbox(db);
  migrateSecretaryChoices(db);
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_events (event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_key TEXT NOT NULL,original_text TEXT NOT NULL,result_json TEXT NOT NULL,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL,response_message_id TEXT);
    CREATE INDEX IF NOT EXISTS secretary_history ON secretary_events(conversation_key,created_at);
    CREATE TABLE IF NOT EXISTS secretary_pending (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,command_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,original_text TEXT NOT NULL,source_message_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_task_choice (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,kind TEXT NOT NULL,candidate_ids TEXT NOT NULL,fields_json TEXT NOT NULL,original_text TEXT NOT NULL,source_message_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_confirmation_views (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,preview_event_key TEXT NOT NULL,requires_restatement INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS secretary_task_intake (conversation_key TEXT PRIMARY KEY,draft_json TEXT NOT NULL,last_event_key TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_reminders (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,sender_number TEXT NOT NULL,group_id TEXT,task_id TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,sent_at INTEGER,sending_at INTEGER,responded_at INTEGER,reply_message_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS secretary_reminders_due ON secretary_reminders(state,due_at);
    CREATE TABLE IF NOT EXISTS secretary_playbook (id TEXT PRIMARY KEY,body TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  // Seed once; never overwrites a value Basim already saved via the
  // admin-only update command (INSERT OR IGNORE keyed on the fixed 'main' id).
  db.prepare("INSERT OR IGNORE INTO secretary_playbook (id,body,updated_by,updated_at) VALUES ('main',?,?,?)").run(DEFAULT_PLAYBOOK, "system", 0);
}
function actorFor(db: DatabaseSync, event: Event, config: TeamChatConfig) {
  return resolveChatUser({ senderNumber: event.senderNumber, groupId: event.groupId }, config.contacts, db.prepare("SELECT id,name,role,active FROM users").all() as ChatUser[], config.allowedGroupIds);
}
function stateFor(db: DatabaseSync, actor: ChatUser): Snapshot { return getManagementSnapshot(db, actor) as unknown as Snapshot; }
// Same base filter + overdue/pending-first ordering as the displayed task
// list (readReply's "ordered" array) so a task's position number is always
// identical wherever it's shown -- the list a user sees and the list any
// number they type is resolved against must never diverge.
function orderedTasks(state: Snapshot, now: number): Task[] {
  const tasks = state.tasks.filter(t => !t.archivedAt);
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const overdue = tasks.filter(t => t.status !== "completed" && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => t.status === "approval");
  return [...tasks].sort((a, b) => Number(overdue.includes(b)) - Number(overdue.includes(a)) || Number(pending.includes(b)) - Number(pending.includes(a)));
}
// Available to every actor, admin included, so "task N" can be resolved
// locally against the exact numbered list that was displayed -- completed/
// approval-status tasks stay in (for positional parity with the display)
// but keep their real status so callers can reject taking those cleanly.
function ownershipCandidates(state: Snapshot, now: number): NonNullable<SecretaryModelInput["ownershipCandidates"]> {
  return orderedTasks(state, now).slice(0, 80)
    .map(task => ({ id: task.id, title: task.title, status: task.status, assignee: task.owner || task.suggestedOwner }));
}
function fingerprint(state: Snapshot) { return hash({ tasks: state.tasks, users: state.users.map(u => ({ id: u.id, name: u.name, role: u.role, active: u.active })), comments: state.comments }); }
function scopeAllowed(scope: string[], state: Snapshot) { const ids = new Set(state.tasks.map(t => "t:" + t.id)); return scope.every(id => ids.has(id)); }
function conversationHistory(db: DatabaseSync, key: string, state: Snapshot, now: number, anchor?: { created_at: number; sequence: number }): HistoryRow[] {
  const rows = (anchor
    ? db.prepare("SELECT original_text,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND created_at>? AND (created_at<? OR (created_at=? AND rowid<=?)) ORDER BY created_at DESC,rowid DESC LIMIT 8")
      .all(key, now - HISTORY_MS, anchor.created_at, anchor.created_at, anchor.sequence)
    : db.prepare("SELECT original_text,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 8")
      .all(key, now - HISTORY_MS)) as HistoryRow[];
  // Never let an inaccessible event supply either model context or task focus.
  return rows.reverse().filter(row => scopeAllowed(JSON.parse(row.scope_json), state));
}
function boundedHistory(rows: HistoryRow[], quote?: { result_json: string }): SecretaryModelInput["history"] {
  const quoted = quote ? ("الرسالة التي يرد عليها المستخدم الآن: " + String(JSON.parse(quote.result_json).reply)).slice(0, 900) : "";
  let remaining = HISTORY_CHARS - quoted.length;
  const history: SecretaryModelInput["history"] = [];
  // Preserve complete recent pairs first; older pairs are shortened to the remaining budget.
  for (const row of [...rows].reverse()) {
    if (remaining < 2) break;
    const user = row.original_text.slice(0, Math.min(600, Math.floor(remaining / 2)));
    const assistant = String(JSON.parse(row.result_json).reply).slice(0, Math.min(900, remaining - user.length));
    history.unshift({ role: "user", content: user }, { role: "assistant", content: assistant });
    remaining -= user.length + assistant.length;
  }
  if (quoted) history.push({ role: "assistant", content: quoted });
  return history;
}
function lookup(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot): Result | null {
  const row = db.prepare("SELECT payload_hash,actor_id,result_json,scope_json FROM secretary_events WHERE event_key=?").get(eventKey(event)) as { payload_hash: string; actor_id: string; result_json: string; scope_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== eventHash(event) || row.actor_id !== actor.id || !scopeAllowed(JSON.parse(row.scope_json), state)) return { status: "denied", reply: "" };
  const result = JSON.parse(row.result_json);
  // A task-action poll (see taskActionPoll) is the one kind of choices any
  // active employee can legitimately be replaying in their own private chat
  // -- every other kind (CFM confirmations, APR approval decisions, the
  // approval-decision listing poll) stays Basim-only, exactly as before.
  const taskPoll = typeof result.choices?.id === "string" && result.choices.id.startsWith("TSKQ");
  if (result.choices && (taskPoll ? (actor.active !== 1 || event.groupId !== null) : (actor.id !== "basem" || actor.role !== "admin" || actor.active !== 1 || event.groupId !== null))) return { status: "denied", reply: "" };
  if (result.status === "confirmation" || (result.status === "clarify" && isConfirmationAttempt(event.text))) {
    const lastInstruction = String(result.reply).lastIndexOf("«موافق");
    const legacy = /^«موافق (T[0-9A-F]{6})»/iu.exec(String(result.reply).slice(lastInstruction));
    if (legacy) result.reply = visibleConfirmationReply(result.reply, legacy[1]);
  }
  return { ...result, status: "duplicate" };
}
function save(db: DatabaseSync, event: Event, actor: ChatUser, result: Result, scope: string[], now: number) {
  const bounded = { ...result, reply: result.reply.slice(0, 3800) };
  if (result.status === "confirmation") {
    const key = conversation(event, actor);
    const pending = db.prepare("SELECT token FROM secretary_pending WHERE conversation_key=?").get(key) as { token: string } | undefined;
    if (!pending) throw new Error("Confirmation requires a pending proposal.");
    const previous = confirmationView(db, key);
    bounded.reply = visibleConfirmationReply(bounded.reply, pending.token);
    db.prepare("INSERT INTO secretary_confirmation_views VALUES(?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,preview_event_key=excluded.preview_event_key,requires_restatement=excluded.requires_restatement")
      .run(key, pending.token, eventKey(event), previous && previous.token !== pending.token ? 1 : previous?.requires_restatement ?? 0);
    // Same gate lookup() already enforces for any result.choices (Basim,
    // admin, active, private chat) -- interactive polls never reach a group
    // chat or anyone else, text-only confirmation still works everywhere else.
    if (actor.id === "basem" && actor.role === "admin" && actor.active === 1 && event.groupId === null) {
      bounded.choices = confirmChoices(pending.token, now);
    }
  }
  db.prepare("INSERT INTO secretary_events VALUES (?,?,?,?,?,?,?,?,?)").run(eventKey(event), eventHash(event), actor.id, conversation(event, actor), event.text, JSON.stringify(bounded), JSON.stringify(scope), now, event.responseMessageId ?? null);
  return bounded;
}
function log(db: DatabaseSync, actor: ChatUser, event: Event, action: string, details: Record<string, unknown>, now: number) {
  db.prepare("INSERT INTO audit_logs(actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,'secretary',?,?,?)")
    .run(actor.id, actor.name, action, eventKey(event), JSON.stringify({ summary: "محادثة سكرتير الإدارة", source: "whatsapp_secretary", sourceMessageId: event.messageId, senderNumber: event.senderNumber, originalText: event.text, ...details }), now);
}
const PRIORITIES: Record<string, { icon: string; label: string; color: string }> = {
  red: { icon: "🔴", label: "قصوى", color: "الحمراء" },
  yellow: { icon: "🟡", label: "متوسطة", color: "الصفراء" },
  green: { icon: "🟢", label: "عادية", color: "الخضراء" },
};
// A leading RLM fixes this RTL line's base direction explicitly; a real
// directional isolate (not a bare LRM) then protects multi-digit order
// ("12" never becomes "21") without hijacking that base direction the way
// a plain strong LTR mark did before -- that bug pushed the whole line,
// ordinal included, to the wrong (left) side. Bold for visibility.
// Zero-padded to the list's own digit width so every number takes the same
// visual space in a plain-text WhatsApp message (WhatsApp has no hanging
// indent for wrapped lines, so this is a best-effort alignment aid, not a
// perfect fix -- a long title still wraps back to the bare margin).
export function stableOrdinal(index: number, total = index) { const width = String(total).length; return `\u200F*\u2066${String(index).padStart(width, "0")}\u2069.*`; }

function numberedTaskList(tasks: Task[], now: number) {
  return tasks.map((task, index) => {
    const priority = PRIORITIES[task.priority];
    const overdue = task.status !== "completed" && task.dueDate && task.dueDate < new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
    const suffix = overdue ? ` • 🔴 متأخرة` : task.dueDate ? ` • الموعد: ${clean(task.dueDate, 10)}` : "";
    return `${stableOrdinal(index + 1, tasks.length)} ${priority?.icon || "⚪"} ${clean(task.title, 90).replace(/\*/g, "")} — ${LABELS[task.status] || clean(task.status)} • ${clean(task.owner || task.suggestedOwner || "غير معيّن", 50)}${suffix}`;
  }).join("\n");
}
export function secretaryTaskCard(task: Task, state: Snapshot, now: number, detailed = false) {
  const latest = state.comments.filter(c => c.taskId === task.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const priority = PRIORITIES[task.priority];
  const overdue = task.status !== "completed" && task.dueDate && task.dueDate < new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  // Basim: "شو المطلوب أولوية قصوى؟ شيل المطلوب من القصة" -- this line used to
  // always show "المطلوب: <task.details, or a filler line when empty>", which
  // for a task whose details is empty just echoed the priority back at him
  // (or printed a meaningless "لا توجد تفاصيل إضافية" filler) and read as
  // noise. He only wants the task itself, its status/who/when, and the last
  // update -- never a "required" line, whether or not details is set.
  return `${priority?.icon || "⚪"} ${clean(task.title, 150)}\n${LABELS[task.status] || clean(task.status)}${overdue ? " • متأخرة عن الموعد" : ""}\nالأولوية: ${priority?.label || "غير محددة"}\nالمسؤول: ${clean(task.owner || task.suggestedOwner || "لم يُعيّن")} ${task.dueDate ? `• الموعد: ${clean(task.dueDate, 10)}` : ""}${detailed ? `\n${latest ? `آخر تحديث (${clean(latest.author, 50)}): ${clean(latest.body, 500)}` : "لا يوجد تحديث مسجّل بعد."}` : ""}`;
}
// Basim: "لما أسأله مين أكثر موظف عنده مهام، يحلل ويعطيني إنه أيمن عنده 17
// مهمة" -- ranks every active employee (never Basim himself) by their open,
// non-archived task count, same "owner if claimed, else suggested owner"
// responsibility convention as ownerTaskGroups/numberedTaskList use
// everywhere else, so this always agrees with what those lists show.
function workloadLeaderboard(state: Snapshot): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    if (task.archivedAt || task.status === "completed") continue;
    const responsible = task.owner || task.suggestedOwner;
    if (!responsible) continue;
    counts.set(responsible, (counts.get(responsible) || 0) + 1);
  }
  return state.users.filter(u => u.active === 1 && u.id !== "basem")
    .map(u => ({ name: u.name, count: counts.get(u.name) || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ar"));
}
function workloadReply(state: Snapshot, actor: ChatUser): { result: Result; scope: string[] } {
  const greeting = `أهلًا يا ${clean(actor.name, 60)}، `;
  const board = workloadLeaderboard(state);
  if (!board.length || board[0].count === 0) return { result: { status: "summary", reply: `${greeting}ما في مهام مفتوحة موزّعة على أي موظف حاليًا.` }, scope: [] };
  const [top, ...rest] = board;
  const others = rest.filter(person => person.count > 0);
  const breakdown = others.length ? `\n\nباقي الفريق:\n${others.map(person => `• ${clean(person.name, 60)} — ${taskCountPhrase(person.count)}`).join("\n")}` : "";
  const topTasks = state.tasks.filter(t => !t.archivedAt && t.status !== "completed" && (t.owner || t.suggestedOwner) === top.name);
  return { result: { status: "summary", reply: `${greeting}أكثر موظف عنده مهام حاليًا هو *${clean(top.name, 60)}* وعنده ${taskCountPhrase(top.count)} مفتوحة.${breakdown}\n\nبدك أشوف مهامه القادمة بالتفصيل، أنواعها، أو نحكي كيف نخفف عنه؟` }, scope: topTasks.map(t => "t:" + t.id) };
}
function priorityReadReply(query: Extract<PriorityTaskQuery, { kind: "query" }>, state: Snapshot, now: number, text: string): { result: Result; scope: string[] } {
  const priority = PRIORITIES[query.priority];
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const owner = query.ownerId ? state.users.find(u => u.id === query.ownerId) : null;
  const tasks = state.tasks.filter(t => !t.archivedAt && t.priority === query.priority
    && (!query.ownerId || !!owner && (t.owner || t.suggestedOwner) === owner.name)
    && (!query.status || (query.status === "overdue" ? t.status !== "completed" && !!t.dueDate && t.dueDate < today : t.status === query.status)))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const header = `${priority.icon} *المهام ${priority.color} — أولوية ${priority.label}*${owner ? `\nالمسؤول: ${clean(owner.name, 60)}` : ""}${query.status ? `\nالحالة: ${query.status === "overdue" ? "متأخرة عن الموعد" : LABELS[query.status]}` : ""}\nالمطابق ضمن صلاحياتك (دون الأرشيف): ${tasks.length}\nاللون للأولوية؛ حالة التنفيذ مذكورة لكل مهمة.\n`;
  const offset = query.offset || 0;
  const cards: string[] = [];
  for (const task of tasks.slice(offset, offset + 10)) {
    const card = `${offset + cards.length + 1}. ${secretaryTaskCard(task, state, now)}`;
    if ((header + cards.join("\n\n") + card).length > 3150) break;
    cards.push(card);
  }
  const next = offset + cards.length;
  const continuation = text.trim().replace(/\s+(?:ابتداء\s+)?من\s+(?:رقم\s+)?[0-9٠-٩۰-۹]+[.!؟?\s]*$/u, "").replace(/[.!؟?]+$/u, "");
  const footer = !tasks.length ? "\nما في مهام تطابق هذا الطلب حاليًا."
    : !cards.length ? `\nالقائمة فيها ${tasks.length} مهام فقط. ابدأ من 1.`
    : `\n\nعرض ${offset + 1}–${next} من ${tasks.length}.${next < tasks.length ? ` للتكملة اكتب: «${clean(continuation, 260)} من ${next + 1}».` : ""}`;
  return { result: { status: "summary", reply: header + "\n" + cards.join("\n\n") + footer }, scope: tasks.map(t => "t:" + t.id) };
}
function readReply(plan: SecretaryIntent, actor: ChatUser, state: Snapshot, now: number, privateChat: boolean): { result: Result; scope: string[] } {
  const greeting = `أهلًا يا ${clean(actor.name, 60)}، `;
  if (plan.kind === "help") {
    // Used to be one fixed blurb for everyone that never mentioned the actual
    // task commands and falsely claimed it would "review the question" on
    // "جوابك غلط" feedback (it never did) -- an employee asking for a task-
    // command guide got the same generic text every time, including on
    // repeat, which read as a stuck/broken bot. Now it actually answers that
    // ask by folding in TASK_COMMANDS_LEGEND for employees, and drops the
    // unfulfilled "I'll re-review" promise for everyone.
    const isBasem = actor.id === "basem" && actor.role === "admin";
    const body = isBasem
      ? "احكيلي بطريقتك: شو مهامي؟ اشرح مهمة جديدة، سجل تحديث، أو اعتمد/ارفض طلب معلّق. اسألني عن أي مهمة بالاسم وبجاوبك."
      : `احكيلي بطريقتك: شو مهامي؟ سجل تحديث على مهمة قيد التنفيذ، أو اسألني عن أي مهمة بالاسم.\n${TASK_COMMANDS_LEGEND}\nولو عندك مهمة معروضة عليك وبعدك ما استلمتها: اكتب «استلمت» لبدء التنفيذ.`;
    return { result: { status: "summary", reply: `${greeting}${SECRETARY_IDENTITY}\n${body}\nالدخول للموقع برمز خاص على واتسابك المسجّل:\n${ORIGIN}/` }, scope: [] };
  }
  if (plan.kind === "details") {
    const task = state.tasks.find(t => t.id === plan.taskId);
    if (task) {
      // Group replies never carry an interactive poll (see the "never a live
      // poll in the group" convention already applied to approvals above).
      const choices = privateChat ? taskActionPoll(task, actor.name, now) : undefined;
      return { result: { status: "summary", reply: `${greeting}\n${secretaryTaskCard(task, state, now, true)}\n\nاحكيلي شو صار معك أو شو بدك أعمل عليها.`, taskId: task.id, ...(choices ? { choices } : {}) }, scope: ["t:" + task.id] };
    }
    return { result: { status: "clarify", reply: "أي مهمة بدك أشرح لك؟" }, scope: [] };
  }
  // "مهام خالد" names one person -- report used to always answer with every
  // task from everyone regardless, which is exactly the "sends me everything,
  // not just his tasks" complaint. ownerId (resolved by the model against the
  // users list, same as task_transfer_request/correction) narrows the same
  // report shape down to one person's own tasks instead of a second kind.
  const reportOwner = plan.kind === "report" && plan.fields.ownerId ? state.users.find(u => u.id === plan.fields.ownerId) : null;
  // Same complaint, different axis: "مين عنده مهام مش مستلمة؟" used to get the
  // FULL overview back (every status, including already-claimed progress
  // tasks) because report had no status filter at all -- Basim naming a
  // status ("مش مستلمة", "قيد التنفيذ"...) now narrows the same report shape
  // down to just that one lifecycle status instead of dumping everything.
  const reportStatus = plan.kind === "report" ? plan.fields.status : null;
  // Basim: "لما سالتو شو مهامي طلع مهام الفريق" -- summary is documented
  // (secretary-intent.ts WHOSE TASKS) as always meaning the ACTOR's own
  // مهام/مهامي, never the team's. A plain member's state.tasks already only
  // ever holds their own tasks (getManagementSnapshot scopes it via
  // canViewManagementTask), so this filter is a no-op for them -- but
  // Basim/admin and a department manager deliberately get an UNSCOPED
  // state.tasks (every task, or every task in their department) for the
  // report/team views, so without this, their own "شو مهامي؟" silently
  // reused that same unscoped list and showed everyone's tasks instead of
  // just theirs.
  const summaryOwnerOnly = plan.kind === "summary";
  const tasks = state.tasks.filter(t => !t.archivedAt && (!reportOwner || (t.owner || t.suggestedOwner) === reportOwner.name) && (!reportStatus || t.status === reportStatus)
    && (!summaryOwnerOnly || (t.owner || t.suggestedOwner) === actor.name));
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const overdue = tasks.filter(t => t.status !== "completed" && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => t.status === "approval");
  // The full مكتملة/قيد التنفيذ/... breakdown only makes sense across every
  // status at once -- once reportStatus narrows `tasks` to a single status,
  // that breakdown would just echo the same total back under one line and
  // zeros under all the others, so it's replaced by a single count naming
  // the status actually asked for.
  const header = plan.kind === "report" ? `📋 *${reportOwner ? `ملخص مهام ${clean(reportOwner.name, 60)}` : "ملخص الإدارة"}*\n${reportStatus ? `${LABELS[reportStatus] || clean(reportStatus)}: ${tasks.length}\n`
    : `مكتملة: ${tasks.filter(t => t.status === "completed").length}\nقيد التنفيذ: ${tasks.filter(t => t.status === "progress").length}\nبانتظار باسم: ${pending.length}\nمتأخرة بموعد مسجل: ${overdue.length}\nبدون موعد: ${tasks.filter(t => !t.dueDate && t.status !== "completed").length}\n🔴 قصوى: ${tasks.filter(t => t.priority === "red").length} • 🟡 متوسطة: ${tasks.filter(t => t.priority === "yellow").length} • 🟢 عادية: ${tasks.filter(t => t.priority === "green").length}\n`}` : `${greeting}المهام المتاحة إلك: ${tasks.length}\n`;
  // orderedTasks always re-derives its own list from the FULL state.tasks --
  // it knows nothing about reportOwner/reportStatus -- so without this filter
  // the report header would say "ملخص مهام خالد" (or name one status) while
  // the grouped listing below it still dumped every task from everyone in
  // every status, exactly the bug being fixed here.
  const ordered = orderedTasks(state, now).filter(t => (!reportOwner || (t.owner || t.suggestedOwner) === reportOwner.name) && (!reportStatus || t.status === reportStatus)
    && (!summaryOwnerOnly || (t.owner || t.suggestedOwner) === actor.name));
  if (plan.kind === "summary") {
    const list = numberedTaskList(ordered, now);
    const reply = `${header.trimEnd()}${list ? `\n${list}` : "\nما في مهام متاحة إلك حاليًا."}\n\nتم عرض جميع المهام (${ordered.length}).\nاختار رقم المهمة كما هو مكتوب، مثل: «رقم 12».`;
    return { result: { status: "summary", reply: reply.slice(0, 3750) }, scope: ordered.map(t => "t:" + t.id) };
  }
  let body = "", shown = 0;
  outer: for (const task of ordered) {
    const priority = PRIORITIES[task.priority];
    const days = task.status !== "completed" && task.dueDate && task.dueDate < today ? Math.floor((Date.parse(today) - Date.parse(task.dueDate)) / 86400000) : 0;
    const item = `\n\n${priority?.icon || "⚪"} ${clean(task.title, 150).replace(/\*/g, "")}\n${LABELS[task.status] || clean(task.status)} • ${clean(task.owner || task.suggestedOwner || "غير معيّن", 50)}${days ? ` • 🔴 متأخرة ${days} يوم` : task.dueDate ? ` • الموعد: ${clean(task.dueDate, 10)}` : ""}`;
    if (header.length + body.length + item.length > 3500) break outer;
    body += item; shown++;
  }
  const footer = shown < tasks.length ? `\n\nعرضت ${shown} من ${tasks.length} بسبب طول الرسالة.` : tasks.length ? `\n\nتم عرض جميع المهام (${shown}).` : "\nما في مهام متاحة إلك حاليًا.";
  return { result: { status: "summary", reply: header.trimEnd() + body + footer }, scope: tasks.map(t => "t:" + t.id) };
}
function commandFrom(plan: SecretaryIntent, state: Snapshot): Record<string, unknown> {
  const command: Record<string, unknown> = { action: plan.action };
  if (plan.taskId) command.taskId = plan.taskId;
  // The planner's "command" tool exposes every field so it can describe any
  // action, but each action only ACCEPTS a fixed subset (see ACTION_KEYS in
  // management-actions.ts) -- e.g. "submit" takes no "details". A model that
  // narrates extra context (the completion details on a plain submit) into
  // an unused field must not make the whole action fail downstream; drop
  // whatever that action doesn't recognize instead of forwarding it.
  const allowedFields = plan.action && Object.hasOwn(ACTION_KEYS, plan.action) ? new Set(ACTION_KEYS[plan.action as ManagementCommand["action"]]) : null;
  for (const [key, value] of Object.entries(plan.fields)) {
    if (value === null || key === "remindAt") continue;
    const mapped = key === "body" ? "comment" : key;
    if (allowedFields && !allowedFields.has(mapped)) continue;
    command[mapped] = value;
  }
  const task = state.tasks.find(t => t.id === plan.taskId);
  if (task) Object.assign(command, { expectedUpdatedAt: task.updatedAt, expectedStatus: task.status });
  return command;
}
function commandDescription(command: Record<string, unknown>, state: Snapshot) {
  const task = state.tasks.find(t => t.id === command.taskId);
  const employee = state.users.find(u => u.id === command.ownerId);
  const lines = [ACTION_LABELS[String(command.action)] || "التغيير المطلوب", task ? `المهمة: ${clean(task.title)}` : null,
    command.title ? `العنوان: ${clean(command.title)}` : null,
    command.details ? `التفاصيل: ${clean(command.details, 500)}` : null, employee ? `المسؤول: ${clean(employee.name)}` : null,
    command.comment ? `التعليق: ${clean(command.comment, 500)}` : null,
    command.priority ? `الأولوية: ${PRIORITIES[String(command.priority)]?.label || "غير محددة"}` : null,
    command.dueDate ? `الموعد: ${clean(command.dueDate)}` : null, command.reason ? `السبب: ${clean(command.reason, 350)}` : null];
  return lines.filter(Boolean).join("\n");
}
const AFFIRMATIONS = ["نعم", "موافق", "أكد", "اكد", "أكيد", "اكيد", "نفذ", "تمام", "yes", "confirm"];
function confirmationText(text: string) { return text.trim().replace(/[.!،]/g, "").replace(/\s+/g, " ").toLowerCase(); }
function isConfirmationAttempt(text: string) {
  const value = confirmationText(text);
  return AFFIRMATIONS.includes(value) || /^(?:(?:نعم|موافق|أكد|اكد|أكيد|اكيد|نفذ|تمام|yes|confirm) )?t[0-9a-f]{6}$/.test(value);
}
function isAffirmation(text: string, token: string, matchingQuote: boolean) {
  const value = confirmationText(text), expected = token.toLowerCase();
  return value === expected || AFFIRMATIONS.some(word => value === `${word} ${expected}`) || (matchingQuote && AFFIRMATIONS.includes(value));
}
function isCancellation(text: string) { return /^(?:لا|الغ[يِ]?|إلغاء|الغاء|ألغي|تراجع|cancel|no)[.!،\s]*$/iu.test(text.trim()); }
function confirmationView(db: DatabaseSync, key: string): ConfirmationView | undefined {
  return db.prepare("SELECT token,preview_event_key,requires_restatement FROM secretary_confirmation_views WHERE conversation_key=?").get(key) as ConfirmationView | undefined;
}
function clearConfirmationView(db: DatabaseSync, key: string) { db.prepare("DELETE FROM secretary_confirmation_views WHERE conversation_key=?").run(key); }
function rememberPendingPreview(db: DatabaseSync, event: Event, key: string, pending: Pending | undefined) {
  // Legacy pending proposals require a fresh visible preview before plain approval.
  if (pending && !confirmationView(db, key)) db.prepare("INSERT INTO secretary_confirmation_views VALUES(?,?,?,1)")
    .run(key, pending.token, eventKey({ ...event, messageId: pending.source_message_id }));
}
function visibleConfirmationReply(reply: string, token: string): string {
  // Change only the last generated instruction, never the exact user-supplied outgoing body.
  const instruction = `«موافق ${token}»`, at = reply.lastIndexOf(instruction);
  return at < 0 ? reply : reply.slice(0, at) + "«موافق»" + reply.slice(at + instruction.length);
}
// Basim asked to tap موافق/إلغاء instead of typing them -- reuse the same
// interactive-poll transport already used for ownerId/priority/dueDate
// (see secretary-choices.ts + the bridge's polls.mjs), but without a new
// table: the pending row's own token, embedded in the poll's ids, IS the
// binding to "this exact live proposal" -- identical in trust terms to the
// plaintext "موافق T1A2B3" a person can already type, since a poll vote only
// ever reaches here after polls.mjs's own crypto verifies it came from the
// authorized phone number voting on a poll this bridge really sent.
function confirmChoices(token: string, now: number): SecretaryChoices {
  return { id: `CFM${token}`, title: "أعتمد التنفيذ؟", expiresAt: now + CONFIRM_MS,
    options: [{ id: `CFM${token}Y`, label: "🟢 موافق" }, { id: `CFM${token}N`, label: "🔴 إلغاء" }] };
}
// Inverse of confirmChoices: a tapped poll option arrives as an ordinary
// event with event.choice set instead of typed text. Translate it, once, at
// the very top -- before actorFor/lookup/anything else reads event.text --
// into the exact plain text a person typing the same choice would have sent,
// so every later dedup/staleness/quote check (all keyed off event.text)
// behaves identically whether the confirmation was typed or tapped.
function resolveConfirmChoice(event: Event): Event {
  const choice = event.choice;
  if (!choice || !choice.questionId.startsWith("CFM")) return event;
  const token = choice.questionId.slice(3);
  if (!/^T[0-9A-F]{6}$/.test(token)) return event;
  if (choice.optionId === `CFM${token}Y`) return { ...event, text: `موافق ${token}`, choice: undefined };
  if (choice.optionId === `CFM${token}N`) return { ...event, text: "إلغاء", choice: undefined };
  return event;
}
// Inverse of approvalDecisionPoll (approvals.ts): a proactive approval
// notification's poll -- filed from an employee's own conversation, arriving
// in Basim's chat outside any live turn of his -- is tapped as an ordinary
// event with event.choice set. Unlike confirmChoices/CFM above (bound to one
// conversation's single pending proposal) or the live "approvalDecision"
// secretary_choices slot handled further below (bound to a conversationKey
// and a specific catalog snapshot), this poll's own option ids carry the
// approval id directly, so a tap resolves deterministically with nothing to
// match against and no live state that could have gone stale -- exactly what
// a poll arriving well after, and independently of, any turn of Basim's needs.
function parseApprovalPollChoice(event: Event): { approvalId: string; decision: "approved" | "rejected" } | null {
  const choice = event.choice;
  if (!choice || !choice.questionId.startsWith("APR")) return null;
  const approvalId = choice.questionId.slice(3);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approvalId)) return null;
  if (choice.optionId === `APR${approvalId}Y`) return { approvalId, decision: "approved" };
  if (choice.optionId === `APR${approvalId}N`) return { approvalId, decision: "rejected" };
  return null;
}
// Basim's own tap-based decision on a task submitted for his approval OUTSIDE
// the formal approvals table -- specifically a FINISH tap (see the
// taskActionPollChoice "submit" branch below) or any other "submit" that
// reaches dispatchManagementNotice without ever going through requestTaskClose
// (lib/approvals.ts), which already attaches its own approvalDecisionPoll and
// so never needs this one. Mirrors approvalDecisionPoll/parseApprovalPollChoice's
// exact shape (same 🟢/🔴 labels) but keyed by taskId instead of an approval
// id, since no approval row exists to key off of on this path.
// Basim runs a pharmacy business and doesn't always open WhatsApp within the
// hour a task is submitted -- a poll that died in 60 minutes with no resend
// (see nudgeOwner's "approval" branch for the resend, added after his report
// "تجربة نسخة سكرتير مطور بانتظار اعتماد باسم مع اني اقفلتها") was the actual
// mechanism behind an approval that "arrives" but never closes the task. 24
// hours is a realistic window for a decision that can wait; the whatsapp-
// bridge's own normalizePollChoices caps every poll at the same new ceiling
// (see MAX_POLL_LIFETIME_MS there), so this value must never exceed it.
const TASK_CLOSE_POLL_LIFETIME_MS = 24 * 60 * 60_000;
function taskCloseDecisionPoll(taskId: string, at: number): SecretaryChoices {
  return { id: `TCLQ${taskId}`, title: "قرارك على إنجاز المهمة؟", expiresAt: at + TASK_CLOSE_POLL_LIFETIME_MS,
    options: [{ id: `TCL${taskId}Y`, label: "🟢 اعتماد" }, { id: `TCL${taskId}N`, label: "🔴 رفض" }] };
}
function parseTaskCloseDecisionPollChoice(event: Event): { taskId: string; decision: "approved" | "rejected" } | null {
  const choice = event.choice;
  if (!choice || !choice.questionId.startsWith("TCLQ")) return null;
  const taskId = choice.questionId.slice(4);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return null;
  const prefix = `TCL${taskId}`;
  if (choice.optionId === `${prefix}Y`) return { taskId, decision: "approved" };
  if (choice.optionId === `${prefix}N`) return { taskId, decision: "rejected" };
  return null;
}
// Inverse of taskCloseDecisionPoll's 🔴 option. Unlike 🟢 (approve, resolved
// deterministically below -- "approve" needs no extra input, exactly like
// CLAIM/FINISH), a rejection needs the reason executeManagementAction's own
// "reject" case requires (management-actions.ts's required(command.reason,...)),
// which a tap can't carry. Same rewrite-to-text convention as
// resolveTaskActionTextChoice's NOTE/TRANSFER/EDIT/EXTEND below: the normal
// model-driven pipeline resolves the task from its current title and, per
// secretary-intent.ts's existing "no reason yet" clarify, asks Basim for the
// reason before anything executes.
function resolveTaskCloseDecisionRejectChoice(db: DatabaseSync, event: Event): Event {
  const parsed = parseTaskCloseDecisionPollChoice(event);
  if (!parsed || parsed.decision !== "rejected") return event;
  const task = db.prepare("SELECT title FROM tasks WHERE id=?").get(parsed.taskId) as { title: string } | undefined;
  if (!task) return { ...event, choice: undefined };
  return { ...event, text: `بدي أرفض إنجاز مهمة «${clean(task.title, 150)}»`, choice: undefined };
}
// Basim's "nobody should have to type" ask extended to every employee, not
// just himself: a task's own detail view and the private notice when a task
// lands on someone both attach a poll of the actions that actually apply
// right now (see taskActionPoll below). CLAIM/FINISH need no extra input, so
// a tap resolves them exactly like parseApprovalPollChoice resolves an
// approval decision -- deterministically, no model involved (see the
// dedicated branch in handleSecretaryEvent). NOTE/TRANSFER/EXTEND need
// content a tap can't carry (a note's body, a colleague's name, a new date),
// so those are handled below by resolveTaskActionTextChoice instead.
function parseTaskActionPollChoice(event: Event): { taskId: string; action: "claim" | "submit" | "note" | "transfer" | "extend" | "edit" } | null {
  const choice = event.choice;
  if (!choice || !choice.questionId.startsWith("TSKQ")) return null;
  const taskId = choice.questionId.slice(4);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return null;
  const prefix = `TSK${taskId}`;
  if (!choice.optionId.startsWith(prefix)) return null;
  const ACTIONS: Record<string, "claim" | "submit" | "note" | "transfer" | "extend" | "edit"> = { CLAIM: "claim", FINISH: "submit", NOTE: "note", TRANSFER: "transfer", EXTEND: "extend", EDIT: "edit" };
  const action = ACTIONS[choice.optionId.slice(prefix.length)];
  return action ? { taskId, action } : null;
}
// Inverse of taskActionPoll's NOTE/TRANSFER/EXTEND options. Unlike CLAIM/
// FINISH, these three cannot resolve on the tap alone -- rewrite the tap,
// once, at the very top (same spot resolveConfirmChoice already runs),
// into the exact sentence a person naming the task by its own title would
// have typed, using the task's CURRENT title (never the one shown when the
// poll was sent). The existing model-driven flow already resolves
// plan.taskId from a title mention and already asks for whatever else it
// still needs (the note's content, the colleague's name, the new date) --
// exactly as it would for someone who typed the same sentence themselves.
function resolveTaskActionTextChoice(db: DatabaseSync, event: Event): Event {
  const parsed = parseTaskActionPollChoice(event);
  if (!parsed || parsed.action === "claim" || parsed.action === "submit") return event;
  // Always clear choice here, task found or not: NOTE/TRANSFER/EXTEND are
  // never meant to be resolved deterministically, and the generic live-poll
  // handler further below is scoped to Basim's own task-intake/approval-
  // decision flows -- leaving choice set would fall into that and get denied
  // outright instead of degrading to the plain (if generic) tap-label text.
  const task = db.prepare("SELECT title FROM tasks WHERE id=?").get(parsed.taskId) as { title: string } | undefined;
  if (!task) return { ...event, choice: undefined };
  const title = clean(task.title, 150);
  const text = parsed.action === "note" ? `بدي أضيف ملاحظة على مهمة «${title}»`
    : parsed.action === "transfer" ? `بدي أحول مهمة «${title}» لحدا غيري`
    : parsed.action === "edit" ? `بدي أعدل أولوية مهمة «${title}»`
    : `بدي أمدد موعد مهمة «${title}»`;
  return { ...event, text, choice: undefined };
}
// The one or two actions that actually apply to this task right now, for
// this specific person -- never fewer than 2 (WhatsApp's own poll minimum);
// a single applicable action stays a plain-text nudge instead of a poll.
// Mirrors executeManagementAction's own claim/submit preconditions (see
// management-actions.ts) so a tap either works or fails with that same
// action's normal error message -- never a new, separate notion of "can
// this person act on this task" that could drift from the real one.
function taskActionPoll(task: { id: string; title: string; status: string; owner: string | null; suggestedOwner: string | null }, actorName: string, now: number): SecretaryChoices | undefined {
  if ((task.owner || task.suggestedOwner) !== actorName) return undefined;
  const base = `TSK${task.id}`;
  const options: Array<{ id: string; label: string }> = [];
  if (task.status === "open" && task.owner === null) options.push({ id: `${base}CLAIM`, label: "👋 استلمت المهمة" });
  if (task.status === "progress" && task.owner === actorName) options.push({ id: `${base}FINISH`, label: "✅ خلصت المهمة" }, { id: `${base}NOTE`, label: "📝 أضيف ملاحظة" });
  if (task.status === "open" || task.status === "progress") options.push({ id: `${base}TRANSFER`, label: "🔄 حوّلها لحدا غيري" }, { id: `${base}EDIT`, label: "🔧 غيّر الأولوية" });
  if (task.status === "progress" && task.owner === actorName) options.push({ id: `${base}EXTEND`, label: "🕐 بدي تمديد" });
  return options.length >= 2 ? { id: `TSKQ${task.id}`, title: "شو بدك تعمل بهالمهمة؟", expiresAt: now + 60 * 60_000, options } : undefined;
}
// Same poll, built from a fresh DB row rather than a pre-action snapshot --
// dispatchManagementNotice's private notice fires right after a
// create/reassign/claim/etc. just changed this exact task's status/owner,
// so the snapshot it already holds is one step stale.
function freshTaskActionPoll(db: DatabaseSync, taskId: string, targetName: string, now: number): SecretaryChoices | undefined {
  const row = db.prepare("SELECT id,title,status,owner,suggested_owner AS suggestedOwner FROM tasks WHERE id=?").get(taskId) as
    { id: string; title: string; status: string; owner: string | null; suggestedOwner: string | null } | undefined;
  return row ? taskActionPoll(row, targetName, now) : undefined;
}

function intakeRow(db: DatabaseSync, key: string): IntakeRow | undefined {
  return db.prepare("SELECT draft_json,last_event_key,expires_at FROM secretary_task_intake WHERE conversation_key=?").get(key) as IntakeRow | undefined;
}
function pendingTaskDraft(pending: Pending | undefined, snapshotHash: string, now: number): TaskDraft | null {
  if (!pending || pending.expires_at <= now || pending.snapshot_hash !== snapshotHash) return null;
  const command = JSON.parse(pending.command_json);
  if (command.action !== "add_task") return null;
  return { title: typeof command.title === "string" ? command.title : null, details: typeof command.details === "string" ? command.details : null,
    priority: ["red", "yellow", "green"].includes(command.priority) ? command.priority : null,
    ownerId: command.ownerId === null ? "unassigned" : typeof command.ownerId === "string" ? command.ownerId : null,
    dueDate: command.dueDate === null ? "unscheduled" : typeof command.dueDate === "string" ? command.dueDate : null };
}
function availableDraft(draft: TaskDraft, state: Snapshot): TaskDraft {
  const date = draft.dueDate;
  const validDate = date === "unscheduled" || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date);
  return { title: draft.title?.trim() || null, details: draft.details?.trim() || null,
    priority: draft.priority && ["red", "yellow", "green"].includes(draft.priority) ? draft.priority : null,
    ownerId: draft.ownerId === "unassigned" || state.users.some(user => user.id === draft.ownerId && user.active === 1) ? draft.ownerId : null,
    dueDate: validDate ? date : null };
}
// A task is a flat, standalone record, so the intake questionnaire starts
// straight at the work itself -- there is no "which project?" step at all.
function intakeQuestion(draft: TaskDraft): string | null {
  if (!draft.title) return "شو المهمة أو الشغل المطلوب بالضبط؟";
  if (!draft.ownerId) return "مين بدك يمسك المهمة؟ اذكر الموظف، أو قل «بدون مسؤول حاليًا».";
  if (!draft.priority) return "شو أولويتها: 🔴 قصوى، 🟡 متوسطة، ولا 🟢 عادية؟ هاي أولوية الشغل، مش حالة تنفيذه.";
  if (!draft.dueDate) return "شو موعدها؟ اذكر التاريخ، أو قل «بدون موعد».";
  return null;
}
function choiceCatalogHash(state: Snapshot) {
  return hash({ users: state.users.map(user => ({ id: user.id, name: user.name, active: user.active, role: user.role })) });
}
function missingChoiceField(draft: TaskDraft): Exclude<SecretaryChoiceField, "approvalDecision"> | null {
  if (!draft.title) return null;
  if (!draft.ownerId) return "ownerId";
  if (!draft.priority) return "priority";
  return draft.dueDate ? null : "dueDate";
}
function intakeChoices(db: DatabaseSync, actor: ChatUser, state: Snapshot, draft: TaskDraft, key: string, now: number): SecretaryChoices | undefined {
  // The interactive choice-button storage is scoped to Basim's own chat only
  // (see createSecretaryChoices); an employee's intake question always falls
  // back to a plain free-text question instead.
  if (actor.id !== "basem" || actor.role !== "admin") return undefined;
  const field = missingChoiceField(draft); if (!field) return undefined;
  const options = secretaryChoiceOptions(field, { users: state.users.filter(user => user.active === 1), now });
  if (!options.length) return undefined;
  const titles = { ownerId: "مين المسؤول عن المهمة؟", priority: "اختار الأولوية، وليس حالة التنفيذ", dueDate: "اختار موعد المهمة بتوقيت عمّان" };
  return createSecretaryChoices(db, { conversationKey: key, actorId: actor.id, draftVersion: hash(intakeRow(db, key)), catalogHash: choiceCatalogHash(state),
    field, title: titles[field], options, now, expiresAt: Math.min(now + INTAKE_MS, intakeRow(db, key)?.expires_at ?? now) });
}
function currentIntakeQuestion(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, key: string, now: number): { result: Result; scope: string[] } | null {
  const live = intakeRow(db, key);
  if (!live || live.expires_at <= now) return null;
  const draft = availableDraft(JSON.parse(live.draft_json), state);
  const question = intakeQuestion(draft);
  if (!question) return { result: { status: "clarify", reply: "لم أنشئ المهمة؛ نحتاج معاينة نهائية وموافقتك عليها قبل التنفيذ." }, scope: [] };
  const choices = event.groupId === null ? intakeChoices(db, actor, state, draft, key, now) : undefined;
  return { result: { status: "clarify", reply: question + (choices ? `\n\n${choices.options.map(option => option.label).join("\n")}\nاختار خيارًا واحدًا، أو اكتب اسم الخيار بالكلام.` : ""), ...(choices ? { choices } : {}) }, scope: [] };
}
function taskIntake(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, plan: SecretaryIntent,
  key: string, existingDraft: TaskDraft | null, now: number, freeTextField?: SecretaryChoiceField): Result {
  const isAdmin = actor.id === "basem" && actor.role === "admin";
  // Employees may now open a task too (it goes to Basim for a decision instead
  // of self-confirming -- see below), but only from a private chat with the
  // secretary; a group message can't start or continue this.
  if (!isAdmin && event.groupId !== null) return save(db, event, actor, { status: "denied", reply: "فتح مهمة جديدة لازم يكون من رسالة خاصة معي، مش من الجروب. راسلني عالخاص." }, [], now);
  if (plan.intakeMode !== "start" && (plan.intakeMode !== "continue" || !existingDraft)) {
    db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
    clearSecretaryChoices(db, key);
    return save(db, event, actor, { status: "clarify", reply: "ما في مسودة مهمة حالية نكمل عليها. احكيلي المهمة الجديدة المطلوبة من البداية." }, [], now);
  }
  const proposed: TaskDraft = { title: plan.fields.title, details: plan.fields.details,
    priority: plan.fields.priority, ownerId: plan.fields.ownerId, dueDate: plan.fields.dueDate };
  if (plan.intakeMode === "continue" && existingDraft) {
    for (const field of Object.keys(proposed) as Array<keyof TaskDraft>) {
      if (proposed[field] === null) Object.assign(proposed, { [field]: existingDraft[field] });
    }
  }
  // An employee always opens a task for himself -- there is no one else to
  // assign it to from this flow -- so the owner question never applies to him.
  if (!isAdmin && proposed.ownerId === null) proposed.ownerId = actor.id;
  const draft = availableDraft(proposed, state);
  clearSecretaryChoices(db, key);
  // Collecting a new proposal never reuses an older task/send confirmation.
  db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
  db.prepare("INSERT INTO secretary_task_intake VALUES(?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET draft_json=excluded.draft_json,last_event_key=excluded.last_event_key,expires_at=excluded.expires_at")
    .run(key, JSON.stringify(draft), eventKey(event), now + INTAKE_MS);
  const question = intakeQuestion(draft);
  if (question) {
    if (freeTextField) return save(db, event, actor, { status: "clarify", reply: freeTextField === "dueDate" ? "اكتب التاريخ المطلوب باليوم والشهر والسنة." : "اكتب اسم الموظف المقصود." }, [], now);
    const choices = event.groupId === null ? intakeChoices(db, actor, state, draft, key, now) : undefined;
    return save(db, event, actor, { status: "clarify", reply: question + (choices ? `\n\n${choices.options.map(option => option.label).join("\n")}\nاختار خيارًا واحدًا، أو اكتب اسم الخيار بالكلام.` : ""), ...(choices ? { choices } : {}) }, [], now);
  }
  const owner = state.users.find(item => item.id === draft.ownerId);
  db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
  const chainHint = "\n\nلو بدك تضيف مهمة كمان، احكيها عادي.";
  if (!isAdmin) {
    // Not Basim's decision to make directly -- file it and let him decide,
    // same pattern as task_close/ownership requests.
    try {
      const request = requestTaskCreate(db, actor, { title: draft.title!, details: draft.details || undefined,
        priority: draft.priority!, dueDate: draft.dueDate === "unscheduled" ? null : draft.dueDate,
        ownerId: draft.ownerId === "unassigned" ? null : draft.ownerId }, { now });
      enqueueAgentMessage(db, { toUser: "basem", text: request.ownerMessage, choices: request.choices }, now);
      notifyTaskLegend(db, actor.id, now + 1);
      log(db, actor, event, "secretary_proposal", { summary: "رفع طلب فتح مهمة لباسم", approvalId: request.approval.id, confirmationRequired: false }, now);
      return save(db, event, actor, { status: "applied", reply: `📨 رفعت طلبك لباسم: ${request.approval.summary}\nبخبرك أول ما يقرر.${chainHint}` }, [], now);
    } catch (error) {
      if (!(error instanceof ManagementActionError)) throw error;
      return save(db, event, actor, { status: "clarify", reply: error.message }, [], now);
    }
  }
  // One single creation path for the admin: a plain add_task command, confirmed
  // and then executed through perform() exactly like a task opened on the
  // website -- which is what makes dispatchManagementNotice fire (group notice
  // plus the new owner's own claim poll). The old "create_standalone_task"
  // pseudo-action that bypassed all of that is gone along with projects.
  const token = "T" + randomBytes(3).toString("hex").toUpperCase();
  const command = { action: "add_task", title: draft.title, ...(draft.details ? { details: draft.details } : {}),
    ownerId: draft.ownerId === "unassigned" ? null : draft.ownerId, priority: draft.priority,
    dueDate: draft.dueDate === "unscheduled" ? null : draft.dueDate };
  const reply = `للتأكيد قبل إنشاء المهمة:\nالمهمة: ${draft.title}${draft.details ? `\nالمطلوب: ${draft.details}` : ""}\nالمسؤول: ${owner ? clean(owner.name, 200) : "بدون مسؤول حاليًا"}\nالأولوية: ${PRIORITIES[draft.priority!].icon} ${PRIORITIES[draft.priority!].label}\nالموعد: ${draft.dueDate === "unscheduled" ? "بدون موعد" : draft.dueDate}\nالحالة عند الإنشاء: مفتوحة بانتظار الاستلام.\n\nلم أنشئ المهمة بعد. اكتب «موافق ${token}» أو رد مباشرة بالموافقة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.`;
  if (reply.length > 3700) return save(db, event, actor, { status: "clarify", reply: "تفاصيل المهمة طويلة للمعاينة الكاملة. اختصر التفاصيل حتى أعرضها كلها قبل التأكيد." }, [], now);
  db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), fingerprint(state), event.text, event.messageId, now + CONFIRM_MS);
  log(db, actor, event, "secretary_proposal", { summary: "عرض إنشاء مهمة بعد استكمال بياناتها", proposedCommand: command, confirmationRequired: true }, now);
  return save(db, event, actor, { status: "confirmation", reply }, [], now);
}

function reminder(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskId: unknown, due: unknown, now: number): Result {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || typeof due !== "number" || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000) return save(db, event, actor, { status: "clarify", reply: "حدد المهمة وموعدًا قادمًا للتذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
  if (Number((db.prepare("SELECT count(*) AS n FROM secretary_reminders WHERE actor_id=? AND state='pending'").get(actor.id) as { n: number }).n) >= 30) return save(db, event, actor, { status: "clarify", reply: "عندك 30 تذكيرًا قادمًا. خلينا نراجعها قبل إضافة المزيد." }, [], now);
  const id = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO secretary_reminders(id,actor_id,sender_number,group_id,task_id,due_at,created_at,reply_message_id) VALUES(?,?,?,?,?,?,?,?)").run(id, actor.id, event.senderNumber, event.groupId, task.id, due, now, "TITANIUMREM" + id.toUpperCase());
  log(db, actor, event, "secretary_reminder", { summary: "جدول تذكيرًا لمهمة", taskId: task.id, dueAt: due }, now);
  return save(db, event, actor, { status: "scheduled", reply: `جدولت تذكيرك عن «${clean(task.title)}» يوم ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)} في نفس المحادثة.`, taskId: task.id }, ["t:" + task.id], now);
}
// Basim: "بدي اقولو يستلم مهمه محوله اله اساسا بس ما استلمها" -- distinct from
// both remind (only ever reminds the ACTOR himself, later, in his own chat)
// and reassign (mutates the task, resets started_at, needs a "موافق"
// confirmation). This changes nothing about the task at all: it just resends
// the exact same claim/transfer/edit poll dispatchManagementNotice already
// sent, right now, to whoever the task is currently suggested to or owned
// by -- so it needs no confirmation either, same as a plain notification.
function nudgeOwner(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskId: string, now: number): Result {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.archivedAt) return save(db, event, actor, { status: "clarify", reply: "هاي المهمة ما عادت متاحة." }, [], now);
  // Basim: "تجربة نسخة سكرتير مطور بانتظار اعتماد باسم مع اني اقفلتها" -- a
  // task pending his own close decision has no "current owner" to nudge at
  // all; the decision always waits on Basim, whoever owns the task. Its
  // taskCloseDecisionPoll (unlike a formal approvals-table request) has no
  // periodic stale-approval nudge behind it and, until now, no way to get a
  // fresh copy once the poll passed its own expiry -- a tap after that point
  // (or a later "اعتمد" typed as plain text, which only ever resolves against
  // the formal approvals table, never this task-close path) both silently do
  // nothing, so the request could get permanently stuck with zero recourse
  // from WhatsApp. nudge already exists, is already Basim-only, and already
  // means "resend the live poll for this task right now" -- this is that,
  // pointed at the one poll that is actually his to resend.
  if (task.status === "approval") {
    enqueueAgentMessage(db, { toUser: "basem", text: `⏳ تذكير: بانتظار قرارك على إنجاز المهمة: ${clean(task.title)}`, choices: taskCloseDecisionPoll(task.id, now) }, now);
    log(db, actor, event, "secretary_nudge", { summary: "أعاد إرسال استطلاع القرار على إنجاز المهمة لباسم", taskId: task.id, targetUserId: "basem" }, now);
    return save(db, event, actor, { status: "applied", reply: `✅ بعتّلك من جديد طلب القرار على: ${clean(task.title)}` }, ["t:" + task.id], now);
  }
  const responsible = task.owner || task.suggestedOwner;
  if (!responsible) return save(db, event, actor, { status: "clarify", reply: "هاي المهمة ما إلها مسؤول حاليًا لتذكيره." }, ["t:" + task.id], now);
  if (responsible === actor.name) return save(db, event, actor, { status: "clarify", reply: "هاي مهمتك انت -- ما في حدا غيرك لتذكيره فيها." }, ["t:" + task.id], now);
  const targetId = state.users.find(u => u.name === responsible)?.id;
  if (!targetId) return save(db, event, actor, { status: "clarify", reply: "ما قدرت ألاقي حساب هذا الموظف لأرسله تذكيرًا." }, ["t:" + task.id], now);
  const choices = freshTaskActionPoll(db, taskId, responsible, now);
  enqueueAgentMessage(db, { toUser: targetId, text: `⏳ يا ${clean(responsible)}، مهمة «${clean(task.title)}» لسا بانتظار ردك.`, ...(choices ? { choices } : {}) }, now);
  notifyTaskLegend(db, targetId, now + 1, !choices);
  log(db, actor, event, "secretary_nudge", { summary: "أعاد إرسال تذكير المهمة لصاحبها الحالي", taskId: task.id, targetUserId: targetId }, now);
  return save(db, event, actor, { status: "applied", reply: `✅ بعتّ لـ${clean(responsible)} تذكيرًا بمهمة «${clean(task.title)}».`, taskId: task.id }, ["t:" + task.id], now);
}

// Search only an exact user-authored question, never model-extracted history or a
// task catalog. Internal questions are answered through authorized DB reads.
function privateSearchQuestion(query: string, state: Snapshot): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
  const value = normalize(query);
  return !query.trim() || query.length > 500 || (value.match(/[0-9٠-٩۰-۹]/gu)?.length ?? 0) >= 6
    || /@|https?:\/\/|(?:مهمتي|مهامي|موظف|مريض|رقم الهويه|رمز الدخول|كلمه السر|ارقام الفريق|ارقام فريق|ارقام الشباب|فريقنا|شركتنا|راتب|رواتب)|\b(?:otp|password|pin|api.?key)\b/u.test(value)
    || [...state.tasks.map(t => t.title), ...state.users.map(u => u.name)]
      .some(title => title.length > 2 && value.includes(normalize(title)));
}

export async function handleSecretaryEvent(db: DatabaseSync, event: Event, config: TeamChatConfig, dependencies: {
  infer: (input: SecretaryModelInput) => Promise<SecretaryIntent>; search?: (query: string) => Promise<string>; now?: () => number;
}): Promise<Result> {
  migrateSecretary(db); const now = (dependencies.now || Date.now)();
  event = resolveConfirmChoice(event);
  event = resolveTaskCommandsLegendChoice(db, event, config, now);
  event = resolveTaskActionTextChoice(db, event);
  event = resolveTaskCloseDecisionRejectChoice(db, event);
  const actor = actorFor(db, event, config); if (!actor) return { status: "denied", reply: "" };
  // The team group is one-way by default: automated notices only (task
  // open/close broadcasts, sent separately as groupNotice from a DM-side
  // action). The secretary does not reply to ordinary chatter it receives FROM
  // the group -- there is no live back-and-forth there for a message that
  // isn't for it. The one exception: someone directly calling it by name
  // ("يا سكرتير...") gets an actual reply, in the group, from everything below
  // -- which already has its own per-action/per-actor rules for group origin
  // (task drafting and message_team/announce_group all stay
  // private-chat-only regardless).
  if (event.groupId !== null && !isAddressedToSecretary(event.text)) return { status: "denied", reply: "" };
  const initial = stateFor(db, actor); const previous = lookup(db, event, actor, initial); if (previous) return previous;
  const key = conversation(event, actor); const initialHash = fingerprint(initial);
  const profileCommand = personalMemoryCommand(event.text);
  if (profileCommand && actor.id === "basem" && actor.role === "admin" && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      updatePersonalMemory(db, fresh.id, profileCommand, now);
      return save(db, event, fresh, { status: "applied", reply: profileCommand.body === null
        ? `حذفت «${profileCommand.topic}» من ذاكرتك الشخصية.`
        : `حفظت في ذاكرتك الشخصية: ${profileCommand.topic} — ${profileCommand.body}\nتقدر تعدّل نفس الموضوع أو تقول «انس عني: ${profileCommand.topic}».` }, [], now);
    });
  }
  // A proactive approval notification's poll tap -- see parseApprovalPollChoice
  // above for why this resolves directly instead of going through the model.
  const approvalPollChoice = parseApprovalPollChoice(event);
  if (approvalPollChoice && actor.id === "basem" && actor.role === "admin" && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      try {
        const result = applyDecision(db, fresh, { approvalId: approvalPollChoice.approvalId, decision: approvalPollChoice.decision }, now);
        deliverAgentSideEffects(db, fresh, result, now);
        return save(db, event, fresh, { status: result.status, reply: result.reply }, [], now);
      } catch (error) {
        if (!(error instanceof ManagementActionError)) throw error;
        return save(db, event, fresh, { status: "clarify", reply: error.message }, [], now);
      }
    });
  }
  // The 🟢 half of taskCloseDecisionPoll (Basim deciding on a FINISH-tap
  // submit that never went through the formal approvals table) -- resolves
  // directly for the same reason parseApprovalPollChoice's own 🟢/🔴 does:
  // the option id already carries the exact task, nothing to look up against
  // a model, no live state that could have gone stale. 🔴 never reaches here
  // -- it was already rewritten to text above (resolveTaskCloseDecisionRejectChoice),
  // since executeManagementAction's "reject" requires a reason a tap can't carry.
  const taskCloseDecisionChoice = parseTaskCloseDecisionPollChoice(event);
  if (taskCloseDecisionChoice && taskCloseDecisionChoice.decision === "approved"
      && actor.id === "basem" && actor.role === "admin" && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      const state = stateFor(db, fresh);
      const task = state.tasks.find(t => t.id === taskCloseDecisionChoice.taskId);
      if (!task) return save(db, event, fresh, { status: "clarify", reply: "هاي المهمة ما عادت متاحة." }, [], now);
      try {
        const result = executeManagementAction(db, fresh, { action: "approve", taskId: task.id } as ManagementCommand,
          { now, source: "whatsapp_secretary", auditContext: { originalText: event.text, sourceMessageId: event.messageId, confirmationRequired: false } });
        dispatchManagementNotice(db, fresh, state, result, {}, now);
        return save(db, event, fresh, { status: "applied", reply: `✅ ${result.message}`, taskId: task.id }, ["t:" + task.id], now);
      } catch (error) {
        if (!(error instanceof ManagementActionError)) throw error;
        return save(db, event, fresh, { status: "clarify", reply: error.message }, [], now);
      }
    });
  }
  // A task-action poll's CLAIM/FINISH tap (see taskActionPoll above) --
  // resolves directly for the same reason parseApprovalPollChoice does: the
  // option id already carries the exact task and action, with nothing to
  // look up against a model and no live state that could have gone stale. A
  // tap is bound to a specific verified phone number voting on a poll this
  // bridge itself sent, so it needs no separate typed confirmation step --
  // the same trust level "claim" already has today with zero confirmation,
  // extended here to "submit" too. Open to any active actor in their own
  // private chat, not just Basim: these are two everyday actions any
  // employee already has today, just reachable with a tap instead of typing.
  const taskActionPollChoice = parseTaskActionPollChoice(event);
  if (taskActionPollChoice && (taskActionPollChoice.action === "claim" || taskActionPollChoice.action === "submit")
      && actor.active === 1 && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      const state = stateFor(db, fresh);
      const task = state.tasks.find(t => t.id === taskActionPollChoice.taskId);
      if (!task) return save(db, event, fresh, { status: "clarify", reply: "هاي المهمة ما عادت متاحة." }, [], now);
      // Basim's explicit rule: nobody closes a task without leaving a note on
      // it first. FINISH itself stays a tap -- "ما بدي حد يكتب ولا حد يعمل،
      // بدهم بس يختاروا" is still honored for the action itself -- but a tap
      // carries no free text, so it can only check that a note was already
      // logged this work cycle (via the NOTE tap/flow, which does the actual
      // typing) rather than accept the close with nothing behind it. Scoped
      // to comments added since this claim (started_at), so a note left
      // during an earlier work cycle on a previously reopened task never
      // silently satisfies this one.
      if (taskActionPollChoice.action === "submit") {
        const startedAt = (db.prepare("SELECT started_at AS startedAt FROM tasks WHERE id=?").get(task.id) as { startedAt: number | null } | undefined)?.startedAt ?? 0;
        const hasNote = db.prepare("SELECT 1 FROM comments WHERE task_id=? AND created_at>=? LIMIT 1").get(task.id, startedAt);
        if (!hasNote) return save(db, event, fresh, { status: "clarify",
          reply: `لازم تضيف ملاحظة بنتيجة الشغل قبل ما تقفل «${clean(task.title, 150)}» -- اضغط «📝 أضيف ملاحظة» واكتبها، وبعدين اضغط «✅ خلصت المهمة» تاني.`, taskId: task.id }, [], now);
      }
      try {
        const result = executeManagementAction(db, fresh, { action: taskActionPollChoice.action, taskId: task.id } as ManagementCommand,
          { now, source: "whatsapp_secretary", auditContext: { originalText: event.text, sourceMessageId: event.messageId, confirmationRequired: false } });
        dispatchManagementNotice(db, fresh, state, result, {}, now);
        notifyTaskLegend(db, fresh.id, now);
        return save(db, event, fresh, { status: "applied", reply: `✅ ${result.message}`, taskId: task.id }, ["t:" + task.id], now);
      } catch (error) {
        if (!(error instanceof ManagementActionError)) throw error;
        return save(db, event, fresh, { status: "clarify", reply: error.message }, [], now);
      }
    });
  }
  // The ambiguous/no-match half of the legend's FINISH/TRANSFER/NOTE taps AND
  // of a typed bare command that resolves to the exact same set (see
  // legendTypedPhraseOption/resolveTaskCommandsLegendChoice above) -- a
  // single unambiguous candidate is already rewritten into the normal
  // named-task sentence before this point, so reaching here means zero or
  // several candidate tasks. Several candidates now get the SAME real
  // tappable poll as the close_request/task_transfer_request/comment
  // branches further below (taskChoicePoll + secretary_task_choice), not a
  // plain numbered list nobody can tap -- Basim's report was exactly that: a
  // typed "انهاء المهمة" with two eligible tasks got the same broken
  // numbered-list "clarify" text twice in a row instead of ever offering a
  // real choice.
  const legendChoice = event.choice && event.choice.questionId === "LGDQ" && ["LGDFINISH", "LGDTRANSFER", "LGDNOTE"].includes(event.choice.optionId) ? event.choice : null;
  if (legendChoice && actor.active === 1 && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      const candidates = legendCandidates(stateFor(db, fresh), fresh.name, legendChoice.optionId);
      if (candidates.length === 0) return save(db, event, fresh, { status: "clarify", reply: LEGEND_NO_TASK[legendChoice.optionId] }, [], now);
      const kind = legendChoice.optionId === "LGDFINISH" ? "close_request" : legendChoice.optionId === "LGDTRANSFER" ? "task_transfer_request" : "comment";
      const token = randomBytes(3).toString("hex").toUpperCase();
      // Same upsert as the close_request/task_transfer_request/comment
      // branches further below -- a stale unconsumed row for this
      // conversation must be replaced, never collide with the new one.
      db.prepare("INSERT INTO secretary_task_choice VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,kind=excluded.kind,candidate_ids=excluded.candidate_ids,fields_json=excluded.fields_json,original_text=excluded.original_text,source_message_id=excluded.source_message_id,expires_at=excluded.expires_at")
        .run(key, token, kind, JSON.stringify(candidates.map(t => t.id)), JSON.stringify({}), event.text, event.messageId, now + CONFIRM_MS);
      log(db, fresh, event, "secretary_task_choice", { summary: "عرض اختيار المهمة قبل التنفيذ", kind, candidateIds: candidates.map(t => t.id) }, now);
      return save(db, event, fresh, { status: "clarify", reply: `${LEGEND_MANY_TASK}\n${candidates.map(t => `• ${clean(t.title, 150)}`).join("\n")}`, choices: taskChoicePoll(token, candidates, now) }, candidates.map(t => "t:" + t.id), now);
    });
  }
  // A tap on taskChoicePoll (see the close_request/task_transfer_request/
  // comment/submit branches further below): the tapped option already names
  // which of the exact candidates offered a moment earlier was meant, so it
  // finishes the original command right now with the rest of what the actor
  // already typed (a note's text, a transfer's target owner, ...), exactly
  // as if that one task had been the only candidate all along -- same trust
  // level as every other direct poll resolution above.
  const taskChoicePick = parseTaskChoicePollChoice(event);
  if (taskChoicePick && actor.active === 1 && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      const row = db.prepare("SELECT * FROM secretary_task_choice WHERE conversation_key=?").get(key) as TaskChoiceRow | undefined;
      // Only a tap that actually matches the CURRENT row consumes it -- a
      // stale tap (an old poll, superseded by retyping the same ambiguous
      // command again) must not wipe out a fresh, still-valid choice for the
      // same conversation.
      if (!row || row.token !== taskChoicePick.token || row.expires_at <= now) return save(db, event, fresh, { status: "clarify", reply: "هذا الاختيار ما عاد صالحًا؛ أعد كتابة طلبك." }, [], now);
      db.prepare("DELETE FROM secretary_task_choice WHERE conversation_key=?").run(key);
      const candidateIds = JSON.parse(row.candidate_ids) as string[];
      const state = stateFor(db, fresh);
      // task_transfer_request's own employee-picker poll (see its case in
      // secretary-agent.ts): candidateIds here are USER ids (plus the
      // "__decline__" sentinel), never task ids -- the actual taskId and
      // already-collected reason live in fields_json instead, stashed there
      // when the poll was built. Handle this shape before the generic
      // task-id lookup below, which candidateIds otherwise always feeds.
      if (row.kind === "task_transfer_pick_owner") {
        const stashed = JSON.parse(row.fields_json) as { taskId: string; reason: string };
        const task = state.tasks.find(t => t.id === stashed.taskId);
        if (!task) return save(db, event, fresh, { status: "clarify", reply: "هاي المهمة ما عادت متاحة." }, [], now);
        const pickedId = candidateIds[taskChoicePick.index];
        if (!pickedId) return save(db, event, fresh, { status: "clarify", reply: "هذا الاختيار ما عاد صالحًا؛ أعد كتابة طلبك." }, [], now);
        const syntheticPlan: SecretaryIntent = { ...emptySecretaryIntent("task_transfer_request"), taskId: task.id,
          fields: { ...emptySecretaryIntent().fields, ownerId: pickedId === "__decline__" ? "declined" : pickedId, reason: stashed.reason } };
        const result = handleAgentIntent(syntheticPlan, { db, actor: fresh, now, inputKind: event.inputKind, text: row.original_text, messageId: row.source_message_id, suppressNotices: event.groupId === null && /(?:لا|ما)\s+(?:تبعت|تبعث|ترسل)|بدون\s+(?:رسائل|إشعارات|اشعارات)/u.test(row.original_text), users: state.users, tasks: state.tasks,
          conversationKey: event.groupId === null ? key : undefined,
          stash: command => { const stashToken = "T" + randomBytes(3).toString("hex").toUpperCase(); db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, stashToken, JSON.stringify(command), initialHash, row.original_text, row.source_message_id, now + CONFIRM_MS); log(db, fresh, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now); return stashToken; } });
        if (!result) return save(db, event, fresh, { status: "clarify", reply: "ما قدرت أكمل هذا الطلب." }, [], now);
        deliverAgentSideEffects(db, fresh, result, now);
        return save(db, event, fresh, { status: result.status, reply: result.reply, ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.choices ? { choices: result.choices } : {}) }, [...(result.taskId ? ["t:" + result.taskId] : [])], now);
      }
      const taskId = candidateIds[taskChoicePick.index];
      const task = taskId ? state.tasks.find(t => t.id === taskId) : undefined;
      if (!task) return save(db, event, fresh, { status: "clarify", reply: "هاي المهمة ما عادت متاحة." }, [], now);
      const stashedFields = JSON.parse(row.fields_json) as Record<string, unknown>;
      try {
        if (row.kind === "comment" || row.kind === "submit") {
          return perform(db, event, fresh, state, { action: row.kind, taskId: task.id, ...(row.kind === "comment" ? { comment: stashedFields.comment } : {}) }, now, { originalText: row.original_text, sourceMessageId: row.source_message_id, confirmationRequired: false });
        }
        const base = emptySecretaryIntent(row.kind as "close_request" | "task_transfer_request");
        const syntheticPlan: SecretaryIntent = row.kind === "close_request"
          ? { ...base, taskId: task.id, message: (stashedFields.message as string | null) ?? null, fields: { ...base.fields, details: (stashedFields.details as string | null) ?? null } }
          : { ...base, taskId: task.id, fields: { ...base.fields, ownerId: (stashedFields.ownerId as string | null) ?? null, reason: (stashedFields.reason as string | null) ?? null } };
        const result = handleAgentIntent(syntheticPlan, { db, actor: fresh, now, inputKind: event.inputKind, text: row.original_text, messageId: row.source_message_id, suppressNotices: event.groupId === null && /(?:لا|ما)\s+(?:تبعت|تبعث|ترسل)|بدون\s+(?:رسائل|إشعارات|اشعارات)/u.test(row.original_text), users: state.users, tasks: state.tasks,
          conversationKey: event.groupId === null ? key : undefined,
          stash: command => { const stashToken = "T" + randomBytes(3).toString("hex").toUpperCase(); db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, stashToken, JSON.stringify(command), initialHash, row.original_text, row.source_message_id, now + CONFIRM_MS); log(db, fresh, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now); return stashToken; } });
        if (!result) return save(db, event, fresh, { status: "clarify", reply: "ما قدرت أكمل هذا الطلب." }, [], now);
        deliverAgentSideEffects(db, fresh, result, now);
        return save(db, event, fresh, { status: result.status, reply: result.reply, ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.choices ? { choices: result.choices } : {}) }, [...(result.taskId ? ["t:" + result.taskId] : [])], now);
      } catch (error) {
        if (!(error instanceof ManagementActionError)) throw error;
        return save(db, event, fresh, { status: "clarify", reply: error.message }, [], now);
      }
    });
  }
  const pending = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
  const storedIntake = intakeRow(db, key);
  const pendingDraft = pendingTaskDraft(pending, initialHash, now);
  const draftCandidate = storedIntake && storedIntake.expires_at > now ? JSON.parse(storedIntake.draft_json) : pendingDraft;
  // Continuation state applies to every actor, not just Basim -- an employee
  // mid-way through a multi-turn task-open Q&A needs the same persisted
  // memory of already-answered fields, or each new message has to be
  // re-derived whole from raw history and any unrestated answer gets lost
  // (the same bug class as any multi-turn questionnaire).
  const taskDraft = draftCandidate ? availableDraft(draftCandidate, initial) : null;
  const eventChoice = event.choice;
  if (eventChoice) return transaction(db, () => {
    const freshActor = actorFor(db, event, config);
    if (!config.enabled || !freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor) || freshActor.id !== "basem" || freshActor.role !== "admin"
      || event.groupId !== null || event.inputKind === "voice" || event.replyToMessageId) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    try {
      // Two different kinds of live poll can occupy this conversation's one
      // slot -- a task-intake field question, or (new) an approval-decision
      // poll (see approvalDecisionChoices in secretary-agent.ts). Peek which
      // one is actually stored before committing to the task-draft-specific
      // validation below, which would otherwise reject every approval tap as
      // a stale/mismatched choice.
      if (peekSecretaryChoiceField(db, key) === "approvalDecision") {
        const selected = consumeSecretaryChoice(db, { conversationKey: key, actorId: freshActor.id, draftVersion: "approvalDecision", catalogHash: "approvalDecision", now }, eventChoice);
        const [approvalId, mark] = String(selected.value ?? "").split("|");
        if (!approvalId || (mark !== "Y" && mark !== "N")) throw new SecretaryChoiceError();
        const result = applyDecision(db, freshActor, { approvalId, decision: mark === "Y" ? "approved" : "rejected" }, now);
        deliverAgentSideEffects(db, freshActor, result, now);
        return save(db, event, freshActor, { status: result.status, reply: result.reply }, [], now);
      }
      const liveIntake = intakeRow(db, key);
      if (!taskDraft || !storedIntake || !liveIntake || liveIntake.expires_at <= now || hash(liveIntake) !== hash(storedIntake)) throw new SecretaryChoiceError();
      const selected = consumeSecretaryChoice(db, { conversationKey: key, actorId: freshActor.id, draftVersion: hash(liveIntake), catalogHash: choiceCatalogHash(state), now }, eventChoice);
      const current = availableDraft(JSON.parse(liveIntake.draft_json), state);
      // Only the stored opaque option selects a value; the submitted display label is not an instruction.
      const draft = { ...current, ...(selected.value === null ? {} : { [selected.field]: selected.value }) } as TaskDraft;
      const plan: SecretaryIntent = { kind: "task_draft", intakeMode: "continue", action: null, taskId: null, recipientIds: [], message: null,
        fields: { title: draft.title, details: draft.details, ownerId: draft.ownerId, priority: draft.priority, dueDate: draft.dueDate, name: null, reason: null, body: null, remindAt: null, status: null } };
      return taskIntake(db, event, freshActor, state, plan, key, current, now, selected.value === null ? selected.field : undefined);
    } catch (error) {
      if (!(error instanceof SecretaryChoiceError) && !(error instanceof ManagementActionError)) throw error;
      return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now);
    }
  });
  const quote = event.replyToMessageId ? db.prepare("SELECT event_key,original_text,result_json,scope_json,created_at,rowid AS sequence FROM secretary_events WHERE conversation_key=? AND response_message_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(key, event.replyToMessageId) as { event_key: string; original_text: string; result_json: string; scope_json: string; created_at: number; sequence: number } | undefined : undefined;
  if (event.replyToMessageId && (!quote || !scopeAllowed(JSON.parse(quote.scope_json), initial))) return transaction(db, () => save(db, event, actor, { status: "clarify", reply: "ما قدرت أربط هذا الرد بطلب متاح إلك. اذكر المهمة والتغيير المطلوب بدل الرد على رسالة قديمة أو لشخص آخر." }, [], now));
  const historyRows = conversationHistory(db, key, initial, now);
  const focusResult = quote ? JSON.parse(quote.result_json) : historyRows.length ? JSON.parse(historyRows[historyRows.length - 1].result_json) : null;
  const focusedTask = initial.tasks.find(task => task.id === focusResult?.taskId);
  const focusedTaskId = focusedTask?.id ?? null;
  const history = boundedHistory(historyRows, quote);
  // A reply to an earlier review must recover that review's original question,
  // never a newer unrelated question after the quoted event.
  const reviewingReview = quote && secretaryReviewRequest(quote.original_text, []) !== null;
  const reviewRequest = reviewingReview
    ? secretaryReviewRequest(event.text, boundedHistory(conversationHistory(db, key, initial, now, quote)))
    : secretaryReviewRequest(event.text, history, quote ? { question: quote.original_text, previousAnswer: String(JSON.parse(quote.result_json).reply) } : undefined);
  const earlyRead = (result: Result, scope: string[] = []) => transaction(db, () => {
    const freshActor = actorFor(db, event, config);
    if (!config.enabled || !freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    if (fingerprint(state) !== initialHash) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت بيانات العمل؛ خلينا نراجع آخر وضع." }, [], now);
    rememberPendingPreview(db, event, key, db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined);
    return save(db, event, freshActor, result, scope, now);
  });
  const callerQuestion = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064b-\u065f\u0670\u0640]/g, "").trim();
  // A verb carrying the Arabic plural object pronoun "هم" ("قفلهم" = close
  // THEM, "احذفهم" = delete THEM...) asks for one action on MULTIPLE targets
  // at once. No action in this codebase is bulk -- every command/confirmation
  // resolves to exactly one taskId -- so there is no way to fulfil
  // this literally. Left unguarded, the model either has to guess which
  // items "them" refers to, or (as actually happened once) falls back to
  // focusedTaskId -- the single task a *previous*, unrelated turn
  // last touched -- and silently acts on that instead, producing a
  // confirmation and outcome that look like stale garbage to the user even
  // though nothing was hardcoded; it was just the wrong single target. Ask
  // for the exact items instead of guessing, before the model or
  // focusedTaskId ever see the message, for every actor and even on a
  // reply-quote (quoting doesn't resolve which multiple items "هم" means).
  if (/(?:قفل|سكر|سكّر|اغلق|أغلق|ارشف|أرشف|احذف|امسح|الغ[يو]|افتح|فعّل|عطل|وقف|أوقف)هم(?![ء-ي])/u.test(callerQuestion)) {
    return earlyRead({ status: "clarify", reply: "ما بقدر أنفّذ إجراء على أكثر من مهمة بنفس الرسالة. حدد كل واحدة بالاسم أو الرقم لحالها وبجهزلك تأكيد لكل واحدة على حدة." });
  }
  const callerMatch = /^(?:(?:مرحبا|هلا|اهلا)[،,!\s]+)?(?:مين انا|بتعرفني|من انا)[؟?،,\s]*$/u.exec(callerQuestion);
  if (callerMatch && !event.replyToMessageId) {
    return earlyRead({ status: "summary", reply: `أهلًا ${clean(actor.name, 60)}، بعرفك من رقمك المسجّل عندنا.` });
  }
  // Read-only, any actor, private or group (subject to the same
  // addressed-to-secretary gate applied above for group chats) -- exact
  // phrase only, so it never fires on a message that merely mentions the
  // topic. Bypasses the model entirely: a fixed lookup, never slow/flaky.
  if (/^تعليمات\s+السكرتير[.!؟\s]*$/u.test(callerQuestion) && !event.replyToMessageId) {
    const row = db.prepare("SELECT body FROM secretary_playbook WHERE id='main'").get() as { body: string } | undefined;
    return earlyRead({ status: "summary", reply: row?.body || "ما في تعليمات محفوظة بعد." });
  }
  // Admin-only, private-chat-only direct trigger for an on-demand team
  // reminder broadcast -- bypasses the model since the intent is exact and
  // the action is sensitive (messages every employee + the group), so it
  // still goes through one confirmation like message_team/announce_team.
  // callerQuestion already normalized أ/إ/آ -> ا above, so match only the
  // normalized alef form ("الان", never "الآن") or this never fires.
  const teamReminderMatch = /^(?:ابعت|ارسل|بعت)\s*(?:ال)?تذكير(?:ات)?\s*(?:المهام)?\s*(?:الان|هلق|دلوقتي|حالا)?[.!؟\s]*$/u.test(callerQuestion);
  if (teamReminderMatch && actor.id === "basem" && actor.role === "admin" && event.groupId === null) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || freshActor.id !== "basem" || freshActor.role !== "admin" || freshActor.active !== 1) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    const groups = ownerTaskGroups(state);
    if (!groups.size) return save(db, event, freshActor, { status: "clarify", reply: "ما في مهام مفتوحة معلّقة لأي موظف حاليًا؛ ما في شي أذكّر فيه." }, [], now);
    const names = [...groups.keys()].map(id => state.users.find(u => u.id === id)?.name).filter(Boolean).join("، ");
    const token = "T" + randomBytes(3).toString("hex").toUpperCase();
    // An older, still-unconfirmed preview (message_team/announce_team/a
    // direct edit token/etc.) must never crash this INSERT with a UNIQUE
    // violation on conversation_key -- asking for a fresh preview always
    // replaces whatever Basim hadn't confirmed yet, same as every other
    // mutating direct-intercept in this function.
    db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify({ action: "team_reminders" }), initialHash, event.text, event.messageId, now + CONFIRM_MS);
    log(db, freshActor, event, "secretary_team_reminders_preview", { summary: "عرض تذكير جماعي بالمهام قبل الإرسال", recipients: groups.size }, now);
    return save(db, event, freshActor, { status: "confirmation", reply: `رح أبعت لكل موظف عنده مهام مفتوحة تذكيرًا خاصًا بمهامه (${groups.size} موظف: ${names})، وأنشر على جروب الفريق رسالة منفصلة لكل موظف باسمه فوق مهامه.\n\nلم أرسل شيئًا بعد. اكتب «موافق ${token}» أو رد بالموافقة مباشرة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.` }, [], now);
  });
  // Admin-only, private-chat-only update to the standing "تعليمات السكرتير"
  // text, kept as a plain regex direct-intercept (never routed through the
  // model) so it can never hit the length-related provider timeout seen with
  // long announce_team bodies -- the new text is taken verbatim from
  // whatever follows the first ":" in the raw message, never re-typed by
  // the model. Still goes through one confirmation, same as every other
  // mutating direct-intercept above.
  const playbookColon = event.text.indexOf(":");
  const playbookSetMatch = playbookColon > -1 && /^(?:حدث|حدّث|غير|غيّر|عدل|عدّل)\s+تعليمات\s+السكرتير\s*(?:الى|إلى)?\s*$/u.test(
    event.text.slice(0, playbookColon).normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[ً-ٰٟـ]/g, "").trim());
  if (playbookSetMatch && actor.id === "basem" && actor.role === "admin" && event.groupId === null) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || freshActor.id !== "basem" || freshActor.role !== "admin" || freshActor.active !== 1) return { status: "denied", reply: "" };
    const duplicate = lookup(db, event, freshActor, initial); if (duplicate) return duplicate;
    const body = clean(event.text.slice(playbookColon + 1).trim(), 3500);
    if (!body) return save(db, event, freshActor, { status: "clarify", reply: "شو النص الجديد لتعليمات السكرتير بالضبط؟ اكتبه بعد نقطتين، متل: «حدّث تعليمات السكرتير: النص هون»." }, [], now);
    const token = "T" + randomBytes(3).toString("hex").toUpperCase();
    const command = { action: "update_playbook", body };
    // Same reasoning as team_reminders above -- never crash on a leftover
    // unconfirmed preview from a different command.
    db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
    log(db, freshActor, event, "secretary_playbook_preview", { summary: "عرض تحديث تعليمات السكرتير الدائمة قبل الحفظ", confirmationRequired: true }, now);
    return save(db, event, freshActor, { status: "confirmation", reply: `رح أحدّث تعليمات السكرتير الدائمة (يلي بترجع لما حدا يكتب «تعليمات السكرتير») لهذا النص:\n\n${body}\n\nما حدّثتها بعد. اكتب «موافق ${token}» أو رد بالموافقة مباشرة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.` }, [], now);
  });
  if (isSecretaryIdentityQuery(event.text)) return earlyRead({ status: "summary", reply: SECRETARY_IDENTITY });
  if (reviewRequest?.kind === "clarify") return earlyRead({ status: "clarify", reply: reviewRequest.reply });
  const review = reviewRequest?.kind === "review" ? reviewRequest : null;
  if (storedIntake && isCancellation(event.text)) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const duplicate = lookup(db, event, freshActor, stateFor(db, freshActor)); if (duplicate) return duplicate;
    db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
    db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    clearConfirmationView(db, key);
    clearSecretaryChoices(db, key);
    return save(db, event, freshActor, { status: "cancelled", reply: "ألغيت مسودة المهمة. لم أنشئ مهمة أو أنفّذ طلبًا سابقًا." }, [], now);
  });
  if (!pending && isConfirmationAttempt(event.text)) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    const focusSource = quote ?? historyRows[historyRows.length - 1];
    const visibleFocus = focusSource && scopeAllowed(JSON.parse(focusSource.scope_json), state) ? state.tasks.find(task => task.id === focusedTaskId) : undefined;
    if (!AFFIRMATIONS.includes(confirmationText(event.text))) return save(db, event, actor, { status: "clarify", reply: "ما في طلب معلّق مطابق للتأكيد. اذكر التغيير المطلوب لأعرضه عليك من جديد." }, [], now);
    const currentQuestion = currentIntakeQuestion(db, event, freshActor, state, key, now);
    if (currentQuestion) return save(db, event, freshActor, currentQuestion.result, currentQuestion.scope, now);
    return save(db, event, freshActor, { status: "summary", reply: `تمام يا ${clean(freshActor.name, 60)}، أنا معك.${visibleFocus ? ` نكمل على «${clean(visibleFocus.title, 120)}»؛ احكيلي شو المطلوب.` : " احكيلي كيف أقدر أساعدك."}`, ...(visibleFocus ? { taskId: visibleFocus.id } : {}) }, visibleFocus ? ["t:" + visibleFocus.id] : [], now);
  });
  if (pending && (isConfirmationAttempt(event.text) || isCancellation(event.text))) {
    return transaction(db, () => {
      const freshActor = actorFor(db, event, config); if (!freshActor) return { status: "denied", reply: "" };
      const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
      const live = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
      if (!live || live.token !== pending.token) return save(db, event, freshActor, { status: "clarify", reply: "تغيّر الطلب المعلّق. اذكر التغيير المطلوب من جديد." }, [], now);
      // Expiry is checked against the live row under the lock BEFORE displaying its token.
      if (live.expires_at <= now && !isCancellation(event.text)) {
        db.prepare("DELETE FROM secretary_pending WHERE conversation_key=? AND token=? AND expires_at<=?").run(key, live.token, now);
        clearConfirmationView(db, key);
        clearSecretaryChoices(db, key);
        const currentQuestion = AFFIRMATIONS.includes(confirmationText(event.text)) ? currentIntakeQuestion(db, event, freshActor, state, key, now) : null;
        if (currentQuestion) return save(db, event, freshActor, currentQuestion.result, currentQuestion.scope, now);
        return save(db, event, freshActor, { status: "stale", reply: "انتهى وقت الطلب السابق؛ لم أنفّذ شيئًا. احكيلي المطلوب من جديد لنراجعه بتأكيد جديد." }, [], now);
      }
      if (live.snapshot_hash !== fingerprint(state) && !isCancellation(event.text)) {
        db.prepare("DELETE FROM secretary_pending WHERE conversation_key=? AND token=?").run(key, live.token); clearConfirmationView(db, key);
        return save(db, event, freshActor, { status: "stale", reply: "تغيّرت البيانات أو الصلاحيات؛ لم أنفّذ الطلب. اذكره من جديد لأعرض الوضع الحالي." }, [], now);
      }
      const view = confirmationView(db, key);
      const originalPreviewKey = eventKey({ ...event, messageId: live.source_message_id });
      const matchingQuote = !!quote && JSON.parse(quote.result_json).status === "confirmation"
        && (quote.event_key === originalPreviewKey || (view?.token === live.token && quote.event_key === view.preview_event_key));
      if (quote && !matchingQuote) return save(db, event, freshActor, { status: "clarify", reply: "هذا الرد ليس على الطلب الحالي. رد بالموافقة على معاينته الحالية، أو اكتب «موافق» لأعيد عرضها قبل التنفيذ." }, [], now);
      // A single plain "موافق" is enough once the pending proposal is confirmed
      // live and unchanged (expiry/staleness/quote checks around this block) --
      // no second restatement round. Basim asked for this directly: a mistaken
      // one-shot approval isn't worth a mandatory extra confirmation step.
      if (!isCancellation(event.text) && !isAffirmation(event.text, live.token, matchingQuote) && !AFFIRMATIONS.includes(confirmationText(event.text))) {
        return save(db, event, freshActor, { status: "clarify", reply: "هذه الموافقة ليست للطلب الحالي. رد على معاينته الحالية، أو اكتب «موافق» لأراجعه معك." }, [], now);
      }
      db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      clearConfirmationView(db, key);
      clearSecretaryChoices(db, key);
      if (isCancellation(event.text)) { log(db, freshActor, event, "secretary_cancel", { summary: "ألغى الطلب قبل التنفيذ" }, now); return save(db, event, freshActor, { status: "cancelled", reply: "ألغيت الطلب المعلّق، ما غيّرت المهمة." }, [], now); }
      if (live.expires_at <= now || live.snapshot_hash !== fingerprint(state)) return save(db, event, freshActor, { status: "stale", reply: "انتهى وقت التأكيد أو تغيّرت البيانات/الصلاحيات. ما نفذت الطلب؛ اذكره من جديد لأعرض الوضع الحالي." }, [], now);
      const command = JSON.parse(live.command_json);
      if (command.action === "message_team") {
        try {
          const batch = confirmSecretaryOutboxPreview(db, { batchId: command.batchId, actor: freshActor,
            origin: { senderNumber: event.senderNumber, groupId: event.groupId }, confirmationMessageId: eventKey(event) }, config, { now });
          log(db, freshActor, event, "secretary_message_queued", { summary: "أكد إرسال رسالة منفصلة للموظفين", batchId: batch.batchId, recipientCount: batch.recipientCount, sourceMessageId: live.source_message_id }, now);
          return save(db, event, freshActor, { status: "queued", batchId: batch.batchId, reply: `أكدت الطلب وأضفت الرسالة لطابور الإرسال على الخاص إلى ${batch.recipientCount} موظفين، كل واحد لحاله. هذا ليس تأكيد وصول؛ رح يوصلك تقرير بنتيجة الإرسال.` }, [], now);
        } catch (error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
      }
      if (command.action === "announce_group") {
        if (freshActor.id !== "basem" || freshActor.role !== "admin" || event.groupId !== null) return save(db, event, freshActor, { status: "denied", reply: "نشر إعلان على جروب الفريق متاح لباسم من محادثته الخاصة فقط." }, [], now);
        enqueueAgentMessage(db, { toUser: "group", text: String(command.text || "") }, now);
        log(db, freshActor, event, "secretary_announce_queued", { summary: "أكد نشر إعلان على جروب الفريق" }, now);
        return save(db, event, freshActor, { status: "queued", reply: "أكدت الطلب وأضفت الإعلان لطابور النشر على جروب الفريق. هذا ليس تأكيد نشر فعلي؛ لو تجاوزنا الحد اليومي لرسائل الجروب ممكن يتأخر أو يتجاهل." }, [], now);
      }
      if (command.action === "team_reminders") {
        if (freshActor.id !== "basem" || freshActor.role !== "admin" || event.groupId !== null) return save(db, event, freshActor, { status: "denied", reply: "إرسال تذكير الفريق متاح لباسم من محادثته الخاصة فقط." }, [], now);
        const { recipients } = sendTeamTaskReminders(db, state, now);
        log(db, freshActor, event, "secretary_team_reminders_sent", { summary: "أرسل تذكيرًا يدويًا لكل موظف بمهامه ونشره على الجروب", recipients }, now);
        return save(db, event, freshActor, { status: "applied", reply: recipients ? `✅ بعت تذكيرًا خاصًا لـ${recipients} موظف بمهامهم، ونشرت على الجروب رسالة منفصلة لكل واحد منهم.` : "ما في مهام مفتوحة معلّقة لأي موظف حاليًا؛ ما بعت شي." }, [], now);
      }
      if (command.action === "update_playbook") {
        if (freshActor.id !== "basem" || freshActor.role !== "admin" || event.groupId !== null) return save(db, event, freshActor, { status: "denied", reply: "تحديث تعليمات السكرتير متاح لباسم من محادثته الخاصة فقط." }, [], now);
        const body = String(command.body || "");
        db.prepare("INSERT INTO secretary_playbook (id,body,updated_by,updated_at) VALUES ('main',?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
          .run(body, freshActor.id, now);
        log(db, freshActor, event, "secretary_playbook_updated", { summary: "حدّث تعليمات السكرتير الدائمة" }, now);
        return save(db, event, freshActor, { status: "applied", reply: "✅ حدّثت تعليمات السكرتير الدائمة. أي حدا يكتب «تعليمات السكرتير» رح ياخد هالنص الجديد." }, [], now);
      }
      if (command.action === "schedule_reminder") return reminder(db, event, freshActor, state, command.taskId, command.dueAt, now);
      if (command.action === "close_direct") return closeDirect(db, event, freshActor, state, String(command.taskId), now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId });
      if (command.action === "claim_multi") return claimMultiple(db, event, freshActor, state, Array.isArray(command.taskIds) ? command.taskIds.map(String) : [], now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId });
      if (command.action === "create_tasks" || command.action === "decide_approval") {
        try {
          const result = command.action === "create_tasks"
            // Each task in the bundle is notified individually: createTasks
            // hands every created task straight to dispatchManagementNotice, so
            // its own owner gets the normal claim poll and the group gets the
            // normal notice -- exactly like a single add_task through perform().
            ? createTasks(db, freshActor, { details: typeof command.details === "string" ? command.details : "", tasks: (Array.isArray(command.tasks) ? command.tasks : []) as TaskDraftTask[], suppressNotices: command.suppressNotices === true },
              now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId, senderNumber: event.senderNumber, origin: "whatsapp" },
              (created, ownerId) => dispatchManagementNotice(db, freshActor, state, created, { ownerId }, now))
            : applyDecision(db, freshActor, { approvalId: String(command.approvalId), decision: command.decision === "approved" ? "approved" : "rejected", note: typeof command.note === "string" ? command.note : undefined }, now);
          deliverAgentSideEffects(db, freshActor, result, now);
          return save(db, event, freshActor, { status: result.status, reply: result.reply, ...(result.taskId ? { taskId: result.taskId } : {}) }, [], now);
        } catch (error) { if (!(error instanceof ManagementActionError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
      }
      return perform(db, event, freshActor, state, command, now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId });
    });
  }
  const canMessageTeam = actor.id === "basem" && actor.role === "admin" && event.groupId === null;
  const pendingCommand = canMessageTeam && pending && pending.expires_at > now ? JSON.parse(pending.command_json) : null;
  const input: SecretaryModelInput = { text: event.text, actor: { id: actor.id, name: actor.name, role: actor.role }, focusedTaskId, taskDraft: review ? null : taskDraft,
    ...(review ? { review: { previousQuestion: review.question, previousAnswer: review.previousAnswer } } : {}),
    canMessageTeam, messageRecipients: canMessageTeam ? getSecretaryOutboxRecipients(db, config).map(user => ({ id: user.userId, name: user.name })) : [],
    pendingMessagePreview: pendingCommand?.action === "message_team" && typeof pendingCommand.text === "string" && Array.isArray(pendingCommand.recipientIds) ? { text: pendingCommand.text, recipientIds: pendingCommand.recipientIds } : null,
    tasks: initial.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })),
    users: initial.users.filter(u => u.active === 1).map(u => ({ id: u.id, name: u.name })), history, now: new Date(now).toISOString(),
    ownershipCandidates: review ? [] : ownershipCandidates(initial, now),
    pendingApprovals: safeApprovals(db, actor), rules: safeRules(db),
    personalContext: actor.id === "basem" && actor.role === "admin" && event.groupId === null ? personalMemory(db, actor.id) : [],
    learningMemory: event.groupId === null ? recallSecretaryMemory(db, { conversation: key, role: actor.role,
      query: review?.question || event.text, now,
      allowedScope: new Set(initial.tasks.map(t => "t:" + t.id)) }) : [],
    knowledgeContext: event.groupId === null ? safeKnowledge(db, actor, review?.question || event.text)
      .slice(0, 3).map(hit => ({ title: hit.title, snippet: hit.snippet.slice(0, 600) })) : [] };
  const directCreation = !review && event.inputKind !== "voice" && !event.replyToMessageId ? directTaskCreationIntent(input) : null;
  // A bare color can answer an active creation question; explicit list requests switch topic.
  const readQuestion = review?.question || event.text;
  const priorityQuery = review ? priorityTaskQuery(readQuestion, input)
    : !event.replyToMessageId && (!taskDraft || /مهام|اعط|أعط|وريني|اعرض|اسرد/u.test(event.text)) ? priorityTaskQuery(event.text, input) : null;
  let plan: SecretaryIntent;
  const listText = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064B-\u065F\u0670ـ؟?!.،,]/g, "").replace(/\s+/g, " ").trim();
  // A numbered list follow-up is often sent as just "12". Resolve it locally
  // for employees so it never waits on the language model or loses the RTL
  // context from the preceding list.
  const bareOwnershipOrdinal = !review && event.groupId === null && actor.id !== "basem" && actor.role !== "admin"
    && /^[0-9٠-٩۰-۹]{1,3}$/u.test(listText) && input.ownershipCandidates?.length
    ? Number(listText.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0))) : null;
  const bareOwnershipCandidate = bareOwnershipOrdinal && bareOwnershipOrdinal >= 1 ? input.ownershipCandidates?.[bareOwnershipOrdinal - 1] : undefined;
  const directTaskList = !review && !taskDraft && !event.replyToMessageId
    && /^(?:(?:وريني|اعرض|اعرضلي|اعطيني|اعطني|شو|ارسل|ارسللي|ابعث|ابعثلي|ابعت|ابعتلي|بدي اشوف|بدي شوف|خليني اشوف|خليني شوف) )?المهام(?: المطلوبة| المطلوبه| المتاحة| المتاحه| الموجودة| الموجوده)?(?: كلها| جميعها)?(?: اشوف| بشوف| لاشوف| لأشوف)?(?: كمان مره| كمان مرة| مرة ثانية| مره ثانيه)?$/.test(listText);
  // "مين أكثر موظف عنده مهام؟" -- counting must never be left to the model
  // (same reason every other list in this file is server-computed, not
  // model-recited); a management-only workload leaderboard, computed fresh
  // from the live task catalog. A member's own snapshot only ever contains
  // their own tasks (see canViewManagementTask), so this would silently be
  // wrong for them -- restricted to admin/manager, who actually see everyone.
  const workloadQuery = !review && !taskDraft && !event.replyToMessageId && (actor.role === "admin" || actor.role === "manager")
    && /مهام|شغل|مشغول/.test(listText) && /أكثر|اكثر/.test(listText) && /مين|من |موظف|حدا|واحد|مشغول/.test(listText);
  try {
    plan = workloadQuery ? emptySecretaryIntent("report", "WORKLOAD_LEADERBOARD")
      : priorityQuery ? emptySecretaryIntent(priorityQuery.kind === "clarify" ? "clarify" : "summary", priorityQuery.kind === "clarify" ? priorityQuery.reply : null)
      : directTaskList ? emptySecretaryIntent("summary")
        : bareOwnershipCandidate ? { ...emptySecretaryIntent("ownership_request"), taskId: bareOwnershipCandidate.id }
        : directCreation ?? validateSecretaryIntent(await dependencies.infer(input), input);
  } catch (error) {
    // Only standalone, unqualified read questions may recover from provider failure.
    // Never reinterpret a write, priority filter, quoted reply, or active intake.
    const generalTasks = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064B-\u065F\u0670ـ]/g, "").replace(/[؟?!.،,]/g, "").replace(/\s+/g, " ").trim();
    if (!review && !event.replyToMessageId && !taskDraft
      && /^(?:(?:شو|ايش|ما هي|اعرض|اعرضلي|وريني) )?(?:المهام(?: المطلوب[ةه]| المتاح[ةه]| الموجود[ةه])?|مهامي)(?: عندنا| عندي)?$/.test(generalTasks)) {
      plan = emptySecretaryIntent("summary");
    } else {
      if (!review) throw error;
      plan = emptySecretaryIntent("clarify", "ما قدرت أكمل مراجعة الجواب الآن، وما بدي أخمّن أو أكرر نتيجة غير مؤكدة. حدد النقطة المختلف عليها لنراجعها؛ لم أنفّذ أي تغيير.");
    }
  }
  // Independent of the provider validator: criticism never grants a write/replay.
  if (review && !["summary", "details", "report", "help", "chat", "clarify", "search", "message_status"].includes(plan.kind)) {
    plan = emptySecretaryIntent("clarify", "براجع الجواب معك؛ لم أنفّذ أو أعد إرسال أي طلب. اكتب التغيير المطلوب كطلب جديد إذا بدك تنفيذه.");
  }
  let publicReply: string | null = null;
  if (plan.kind === "search") {
    const query = readQuestion.trim(); // Exact current/prior user question, not plan.message.
    const internal = review ? [] : safeKnowledge(db, actor, query);
    if (internal.length) publicReply = `من قاعدة المعرفة الداخلية:\n\n${formatKnowledgeHits(internal)}\n\n(قل «ابحث على الإنترنت» إذا بدك مصادر عامة.)`;
    else if (privateSearchQuestion(query, initial)) publicReply = "هذا السؤال قد يتضمن معلومات داخلية؛ ما أرسلته لبحث عام. حدد المهمة أو المعلومة العامة المطلوبة بدون بيانات خاصة.";
    else if (!dependencies.search) publicReply = "البحث العام غير مفعّل حاليًا؛ ما عملت بحثًا. أقدر أراجع بيانات الموقع أو أوضح ما يلزم للتحقق.";
    else try { publicReply = await dependencies.search(query); }
    catch (error) {
      if (!review) throw error;
      publicReply = "حاولت البحث للتحقق من السؤال السابق، لكن البحث تعذّر؛ ما عندي مصدر أؤكد منه التصحيح الآن. لم أنفّذ أي تغيير.";
      plan = emptySecretaryIntent("clarify", publicReply);
    }
  }
  return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    if (fingerprint(state) !== initialHash) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت بيانات العمل أثناء قراءة رسالتك. ما عدّلتها؛ أعد الطلب لأراجع آخر وضع." }, [], now);
    if (hash(intakeRow(db, key) ?? null) !== hash(storedIntake ?? null)) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت مسودة المهمة أثناء قراءة رسالتك. لم أنشئ شيئًا؛ أعد آخر جواب لنكمل على التفاصيل الحالية." }, [], now);
    if ((plan.kind === "task_draft" || pendingDraft) && hash(db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) ?? null) !== hash(pending ?? null)) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت معاينة التأكيد أثناء قراءة رسالتك. لم أنشئ شيئًا؛ أعد التصحيح على المعاينة الحالية." }, [], now);
    if (review && event.groupId === null) rememberSecretaryMistake(db, { conversation: key, role: freshActor.role,
      question: review.question, answer: review.previousAnswer, now,
      scope: initial.tasks.map(t => "t:" + t.id) });
    rememberPendingPreview(db, event, key, db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined);
    if (plan.kind === "task_draft") return taskIntake(db, event, freshActor, state, plan, key, taskDraft, now);
    // Only an explicit task_draft plan may continue intake; unrelated subjects cannot revive it later.
    if (!review) {
      if (storedIntake) db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
      if (pendingDraft) db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      clearSecretaryChoices(db, key);
    }
    if (priorityQuery?.kind === "query") {
      const read = priorityReadReply(priorityQuery, state, now, readQuestion);
      return save(db, event, freshActor, read.result, read.scope, now);
    }
    if (plan.kind === "report" && plan.message === "WORKLOAD_LEADERBOARD") {
      const read = workloadReply(state, freshActor);
      return save(db, event, freshActor, read.result, read.scope, now);
    }
    if (plan.kind === "message_status") {
      try {
        const batch = getSecretaryOutboxStatus(db, { actor: freshActor, origin: { senderNumber: event.senderNumber, groupId: event.groupId } }, config);
        return save(db, event, freshActor, { status: "summary", ...(batch ? { batchId: batch.batchId } : {}), reply: batch ? `نتيجة آخر طلب إرسال وافقت عليه للتيم:\n${batch.recipients.map(user => `• ${clean(user.name, 80)}: ${secretaryOutboxDeliveryLabel(user)}`).join("\n")}\nإقرار خادم واتساب: ${batch.acceptedCount}؛ وصول للجهاز: ${batch.deliveredCount}؛ قراءة: ${batch.readCount}. نجاح محاولة النقل وحده لا يثبت الوصول أو القراءة.` : "ما في طلب إرسال للتيم وافقت عليه ومسجّل بعد." }, [], now);
      } catch(error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
    }
    if (plan.kind === "command" || plan.kind === "remind" || plan.kind === "nudge" || plan.kind === "message_team" || plan.kind === "announce_team" || plan.kind === "claim_multiple") db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    if (plan.kind === "claim_multiple") {
      const { items, failed } = JSON.parse(plan.message || "{}") as { items?: Array<{ n: number; id: string; title: string }>; failed?: Array<{ n: number; reason: string }> };
      if (!items?.length) return save(db, event, freshActor, { status: "clarify", reply: "ما قدرت آخذ ولا مهمة من الأرقام يلي ذكرتها." }, [], now);
      const token = "T" + randomBytes(3).toString("hex").toUpperCase();
      const command = { action: "claim_multi", taskIds: items.map(item => item.id) };
      db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
      log(db, freshActor, event, "secretary_proposal", { summary: "عرض استلام عدة مهام دفعة واحدة", proposedCommand: command, confirmationRequired: true }, now);
      const list = items.map(item => `${item.n}. ${clean(item.title, 90)}`).join("\n");
      const skipped = failed?.length ? `\n\nما قدرت آخذ:\n${failed.map(f => `${f.n}. ${f.reason}`).join("\n")}` : "";
      return save(db, event, freshActor, { status: "confirmation", reply: `استلام ${taskCountPhrase(items.length)}:\n${list}${skipped}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء». الطلب صالح 10 دقائق ولن يُنفَّذ إذا تغيّرت بياناته.` }, items.map(item => "t:" + item.id), now);
    }
    if (plan.kind === "message_team") {
      try {
        const preview = createSecretaryOutboxPreview(db, { actor: freshActor, origin: { senderNumber: event.senderNumber, groupId: event.groupId },
          sourceMessageId: eventKey(event), text: plan.fields.body || "", recipientIds: plan.recipientIds[0] === "all-team" ? "all-team" : plan.recipientIds }, config, { now });
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        const reply = `${event.inputKind === "voice" ? "فهمت من الصوت الطلب التالي:\n" : ""}رح أرسل من رقم الإدارة لكل موظف لحاله على الخاص، وليس على الجروب.\nالمستلمون: ${preview.recipients.map(user => user.name).join("، ")}\n\nالنص الذي سيُرسل:\n${preview.text}\n\nلم أرسل شيئًا بعد. اكتب «موافق ${token}» أو رد بالموافقة مباشرة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.`;
        if (reply.length > 3700) return save(db, event, freshActor, { status: "clarify", reply: "المعاينة طويلة؛ اختصر نص الرسالة أو اختر عددًا أقل من المستلمين حتى أعرضها كاملة قبل التأكيد." }, [], now);
        const command = { action: "message_team", batchId: preview.batchId, text: preview.text, recipientIds: preview.recipients.map(user => user.userId) };
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        log(db, freshActor, event, "secretary_message_preview", { summary: "عرض رسالة للتيم قبل الإرسال", batchId: preview.batchId, recipientIds: preview.recipients.map(user => user.userId), confirmationRequired: true }, now);
        return save(db, event, freshActor, { status: "confirmation", batchId: preview.batchId, reply }, [], now);
      } catch(error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
    }
    if (plan.kind === "announce_team") {
      const text = String(plan.fields.body || "").replace(/[ --‪-‮⁦-⁩]/g, "").replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, 3800);
      if (!text) return save(db, event, freshActor, { status: "clarify", reply: "شو نص الإعلان بالضبط يلي بدك تنشره على جروب الفريق؟" }, [], now);
      const token = "T" + randomBytes(3).toString("hex").toUpperCase();
      const command = { action: "announce_group", text };
      db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
      log(db, freshActor, event, "secretary_announce_preview", { summary: "عرض إعلان على جروب الفريق قبل النشر", confirmationRequired: true }, now);
      return save(db, event, freshActor, { status: "confirmation", reply: `رح أنشر هالنص على جروب الفريق من رقم الإدارة (مو على الخاص):\n\n${text}\n\nلم أنشر شيئًا بعد. اكتب «موافق ${token}» أو رد بالموافقة مباشرة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.` }, [], now);
    }
    if (plan.kind === "tasks_draft" && event.groupId !== null && !(freshActor.id === "basem" && freshActor.role === "admin")) return save(db, event, freshActor, { status: "denied", reply: "فتح مهام جديدة لازم يكون من رسالة خاصة معي، مش من الجروب. راسلني عالخاص." }, [], now);
    // Basim's report: "انهاء المهمة"/"تحويل المهمة" typed with more than one
    // eligible task open let the model's own taskId guess through untested --
    // close_request and task_transfer_request are exactly the employee
    // self-service kinds legendCandidates' LGDFINISH/LGDTRANSFER filters were
    // built for, so reuse them: one real candidate silently corrects whatever
    // taskId the model returned (no guess left standing even when it happened
    // to be right), several candidates stop here for a real tappable choice
    // instead of ever trusting that guess. Basim explicitly asked for this to
    // apply to him too -- legendCandidates filters by task.owner===actorName,
    // so for him it only ever fires on tasks HE personally owns as a worker
    // (see close_request's own "owner" branch below), never on the team's
    // tasks in general, which is what makes this safe to leave unguarded.
    if ((plan.kind === "close_request" || plan.kind === "task_transfer_request") && plan.taskId) {
      const candidates = legendCandidates(state, freshActor.name, plan.kind === "close_request" ? "LGDFINISH" : "LGDTRANSFER");
      if (candidates.length === 1) plan = { ...plan, taskId: candidates[0].id };
      else if (candidates.length > 1) {
        const token = randomBytes(3).toString("hex").toUpperCase();
        const fields = plan.kind === "close_request" ? { details: plan.fields.details, message: plan.message } : { ownerId: plan.fields.ownerId, reason: plan.fields.reason };
        // Retyping the same ambiguous command again (e.g. never tapping the
        // first poll) must replace that stale row, not collide with it --
        // conversation_key is this table's primary key, so a second plain
        // INSERT here throws a UNIQUE-constraint error that aborts the whole
        // turn (Basim hit this for real: خالد's second "انهاء المهمة" came
        // back broken instead of a fresh poll).
        db.prepare("INSERT INTO secretary_task_choice VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,kind=excluded.kind,candidate_ids=excluded.candidate_ids,fields_json=excluded.fields_json,original_text=excluded.original_text,source_message_id=excluded.source_message_id,expires_at=excluded.expires_at")
          .run(key, token, plan.kind, JSON.stringify(candidates.map(t => t.id)), JSON.stringify(fields), event.text, event.messageId, now + CONFIRM_MS);
        log(db, freshActor, event, "secretary_task_choice", { summary: "عرض اختيار المهمة قبل التنفيذ", kind: plan.kind, candidateIds: candidates.map(t => t.id) }, now);
        return save(db, event, freshActor, { status: "clarify", reply: `${LEGEND_MANY_TASK}\n${candidates.map(t => `• ${clean(t.title, 150)}`).join("\n")}`, choices: taskChoicePoll(token, candidates, now) }, candidates.map(t => "t:" + t.id), now);
      }
    }
    if (AGENT_KINDS.has(plan.kind)) {
      db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      const result = handleAgentIntent(plan, { db, actor: freshActor, now, inputKind: event.inputKind, text: event.text, messageId: event.messageId, suppressNotices: event.groupId === null && /(?:لا|ما)\s+(?:تبعت|تبعث|ترسل)|بدون\s+(?:رسائل|إشعارات|اشعارات)/u.test(event.text), users: state.users, tasks: state.tasks,
        // Interactive choice-button storage is scoped to Basim's own private
        // chat only (see approvalDecisionChoices/createSecretaryChoices) --
        // same gate intakeChoices already uses for the task-intake polls.
        conversationKey: event.groupId === null ? key : undefined,
        stash: command => { const token = "T" + randomBytes(3).toString("hex").toUpperCase(); db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS); log(db, freshActor, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now); return token; } });
      if (result) { deliverAgentSideEffects(db, freshActor, result, now); return save(db, event, freshActor, { status: result.status, reply: result.reply, ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.choices ? { choices: result.choices } : {}) }, result.taskId ? ["t:" + result.taskId] : [], now); }
    }
    if (plan.kind === "command") {
      const command = commandFrom(plan, state);
      if (freshActor.id !== "basem" && !["claim", "cancel_claim", "comment", "submit"].includes(String(command.action))) return save(db, event, freshActor, { status: "denied", reply: "هذا القرار من صلاحيات باسم. أقدر أساعدك بتحديث مهامك أو إرسالها للمراجعة." }, [], now);
      // Same fix as the close_request/task_transfer_request branch above,
      // for "اضافة ملاحظة"/comment (LGDNOTE) and a typed "submit" that still
      // reaches here as a plain command action (close_request is the normal
      // path for employees now, but nothing stops the model from emitting a
      // bare submit instead) -- both are the other two commands Basim named.
      // Also unguarded for Basim himself per his explicit request: LGDNOTE
      // and LGDFINISH both filter legendCandidates by task.owner===actorName,
      // so for him this only ever matches tasks HE personally owns.
      //
      // Basim's "ضيف ملاحظه" report went further still: the model can also
      // leave command.taskId unset entirely (never even a guess) while still
      // correctly extracting the comment/submit action itself. commandFrom
      // only ever assigns command.taskId when plan.taskId is truthy, so
      // "not a string" here means exactly that -- never a real, wrongly-typed
      // id -- and is safe to treat identically to the 0-candidates case
      // below: fall through unchanged when a legitimate non-self-owned
      // taskId was already resolved (a manager commenting on someone else's
      // task never has any of THEIR OWN candidates here), only speak up when
      // there is truly nothing to fall back on.
      if (command.action === "comment" || command.action === "submit") {
        const candidates = legendCandidates(state, freshActor.name, command.action === "comment" ? "LGDNOTE" : "LGDFINISH");
        if (candidates.length === 1) command.taskId = candidates[0].id;
        else if (candidates.length > 1) {
          const token = randomBytes(3).toString("hex").toUpperCase();
          // Same upsert as the close_request/task_transfer_request branch
          // above -- a stale unconsumed row for this conversation must be
          // replaced, never collide with the new one.
          db.prepare("INSERT INTO secretary_task_choice VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,kind=excluded.kind,candidate_ids=excluded.candidate_ids,fields_json=excluded.fields_json,original_text=excluded.original_text,source_message_id=excluded.source_message_id,expires_at=excluded.expires_at")
            .run(key, token, command.action, JSON.stringify(candidates.map(t => t.id)), JSON.stringify(command.action === "comment" ? { comment: command.comment } : {}), event.text, event.messageId, now + CONFIRM_MS);
          log(db, freshActor, event, "secretary_task_choice", { summary: "عرض اختيار المهمة قبل التنفيذ", kind: command.action, candidateIds: candidates.map(t => t.id) }, now);
          return save(db, event, freshActor, { status: "clarify", reply: `${LEGEND_MANY_TASK}\n${candidates.map(t => `• ${clean(t.title, 150)}`).join("\n")}`, choices: taskChoicePoll(token, candidates, now) }, candidates.map(t => "t:" + t.id), now);
        } else if (typeof command.taskId !== "string") {
          return save(db, event, freshActor, { status: "clarify", reply: LEGEND_NO_TASK[command.action === "comment" ? "LGDNOTE" : "LGDFINISH"] }, [], now);
        }
      }
      if (SENSITIVE.has(String(command.action)) || event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        const scope = plan.taskId ? ["t:" + plan.taskId] : [];
        log(db, freshActor, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now);
        return save(db, event, freshActor, { status: "confirmation", reply: `${event.inputKind === "voice" ? `فهمت من الصوت: «${clean(event.text, 450)}»\n` : ""}للتأكيد قبل التنفيذ:\n${commandDescription(command, state)}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء». الطلب صالح 10 دقائق ولن يُنفّذ إذا تغيّرت بياناته.`, ...(plan.taskId ? { taskId: plan.taskId } : {}) }, scope, now);
      }
      return perform(db, event, freshActor, state, command, now, { originalText: event.text, sourceMessageId: event.messageId, confirmationRequired: false });
    }
    if (plan.kind === "remind") {
      const task = state.tasks.find(t => t.id === plan.taskId); const due = Date.parse(plan.fields.remindAt || "");
      if (!task || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(plan.fields.remindAt || "")) return save(db, event, freshActor, { status: "clarify", reply: "حدد المهمة وموعد التذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
      if (event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify({ action: "schedule_reminder", taskId: task.id, dueAt: due }), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        return save(db, event, freshActor, { status: "confirmation", reply: `فهمت من الصوت: «${clean(event.text, 450)}»\nأجدول تذكيرًا عن «${clean(task.title)}» في ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)}؟\nاكتب «موافق ${token}» أو «إلغاء».` }, ["t:" + task.id], now);
      }
      return reminder(db, event, freshActor, state, task.id, due, now);
    }
    if (plan.kind === "nudge") return nudgeOwner(db, event, freshActor, state, String(plan.taskId), now);
    // Basim: "قصدي ما فتح تصويت" -- give the SAME real tappable choice the
    // exact typed phrase and the tapped legend reminder already get, instead
    // of ever leaving a bare "which task" clarify with no buttons attached.
    // See legendFuzzyPhraseOption above for why this only ever runs on a
    // clarify the model itself already produced.
    if (plan.kind === "clarify" && !review && event.groupId === null && !event.replyToMessageId && event.inputKind !== "voice") {
      const fuzzyOptionId = legendFuzzyPhraseOption(event.text);
      if (fuzzyOptionId) {
        const candidates = legendCandidates(state, freshActor.name, fuzzyOptionId);
        if (candidates.length === 0) return save(db, event, freshActor, { status: "clarify", reply: LEGEND_NO_TASK[fuzzyOptionId] }, [], now);
        if (candidates.length === 1) {
          const title = clean(candidates[0].title, 150);
          const reply = fuzzyOptionId === "LGDNOTE" ? `تقصد مهمة «${title}»؟ اكتب نص الملاحظة.`
            : fuzzyOptionId === "LGDFINISH" ? `تقصد مهمة «${title}»؟ شو نتيجتها بالضبط؟`
            : `تقصد مهمة «${title}»؟ اذكر اسم الزميل المقصود، أو قل «مش مسؤوليتي» بدون تحديد حدا.`;
          return save(db, event, freshActor, { status: "clarify", reply, taskId: candidates[0].id }, ["t:" + candidates[0].id], now);
        }
        const token = randomBytes(3).toString("hex").toUpperCase();
        const kind = fuzzyOptionId === "LGDFINISH" ? "close_request" : fuzzyOptionId === "LGDTRANSFER" ? "task_transfer_request" : "comment";
        // Same upsert as the exact-typed-phrase/tapped-legend branches
        // above -- a stale unconsumed row for this conversation must be
        // replaced, never collide with the new one.
        db.prepare("INSERT INTO secretary_task_choice VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,kind=excluded.kind,candidate_ids=excluded.candidate_ids,fields_json=excluded.fields_json,original_text=excluded.original_text,source_message_id=excluded.source_message_id,expires_at=excluded.expires_at")
          .run(key, token, kind, JSON.stringify(candidates.map(t => t.id)), JSON.stringify({}), event.text, event.messageId, now + CONFIRM_MS);
        log(db, freshActor, event, "secretary_task_choice", { summary: "عرض اختيار المهمة قبل التنفيذ (تخمين احتياطي)", kind, candidateIds: candidates.map(t => t.id) }, now);
        return save(db, event, freshActor, { status: "clarify", reply: `${LEGEND_MANY_TASK}\n${candidates.map(t => `• ${clean(t.title, 150)}`).join("\n")}`, choices: taskChoicePoll(token, candidates, now) }, candidates.map(t => "t:" + t.id), now);
      }
    }
    if (plan.kind === "chat" || plan.kind === "clarify" || plan.kind === "search") {
      let reply = publicReply || plan.message || "أي مهمة تقصد، وشو المطلوب؟";
      if (plan.kind === "chat" || plan.kind === "clarify") reply = safeConversationalReply(reply);
      // The planner explicitly identifies contextual replies; an unrelated topic has no focus.
      const contextTaskId = plan.kind !== "search" && state.tasks.some(task => task.id === plan.taskId) ? plan.taskId : null;
      return save(db, event, freshActor, { status: plan.kind === "clarify" ? "clarify" : "summary", reply, ...(contextTaskId ? { taskId: contextTaskId } : {}) }, plan.kind !== "search" ? state.tasks.map(t => "t:" + t.id) : [], now);
    }
    const read = readReply(plan, freshActor, state, now, event.groupId === null); return save(db, event, freshActor, read.result, read.scope, now);
  });
}
// lib/whatsapp.ts's taskNotification() (the old Meta Cloud API text-only
// formatter) has had zero callers for a while -- the dashboard used to relay
// through it but that call site was removed, leaving task creation/approval
// on the website silently notifying no one. formatManagementNotice +
// dispatchManagementNotice below are the real, current mechanism: reused by
// BOTH the chat-driven paths here (perform/closeDirect/claimMultiple, so a
// task created/claimed/submitted/approved/rejected/reassigned/archived
// directly through the secretary chat produces a group broadcast and a
// heads-up + fresh claim/reject/transfer poll to the task's own owner) AND,
// per Basim's explicit request, app/api/state/route.ts's dashboard action
// branch, so a task opened/approved on the website reaches the employee the
// same way. Delivery goes through the chat outbox (enqueueAgentMessage), not
// the Meta Cloud API, reusing the group's existing emoji/wording conventions
// (see lib/secretary-agent.ts and lib/approvals.ts's notifyGroup strings).
function formatManagementNotice(notification: NonNullable<ManagementResult["notification"]>): string {
  const title = clean(notification.title, 200);
  const who = clean(notification.actor, 100);
  switch (notification.action) {
    case "create": return `🆕 مهمة جديدة: ${title}${notification.extra ? ` — ${notification.extra}` : ""}`;
    case "claim": return `👋 ${who} استلم مهمة «${title}»`;
    case "submit": return `📤 ${who} أنهى «${title}» وبانتظار اعتماد باسم`;
    case "approve": return `✅ اعتُمد إنجاز «${title}» (${who})`;
    case "reject": return `❌ رُفض إنجاز «${title}»${notification.extra ? ` — ${notification.extra}` : ""}`;
    case "reassign": return `🔄 تغيّر المسؤول عن «${title}»${notification.extra ? ` — ${notification.extra}` : ""}`;
    case "archive": return `🗄️ ${who} أرشف مهمة «${title}»`;
    case "comment": return `💬 ${who} علّق على «${title}»${notification.extra ? `: ${notification.extra}` : ""}`;
    case "blocker": return `🚧 ${who} سجّل عائق على «${title}»${notification.extra ? `: ${notification.extra}` : ""}`;
    default: return `📌 تحديث على «${title}» (${who})`;
  }
}
/** Broadcasts result.notification to the group and privately heads-up the
 * task's CURRENT owner (freshly read from the DB, since the action just
 * changed it for add_task/reassign) -- never the actor about his own action. */
export function dispatchManagementNotice(db: DatabaseSync, actor: ChatUser, state: Snapshot, result: ManagementResult, context: { ownerId?: string | null }, now: number) {
  if (!result.notification) return;
  const taskId = result.entityType === "task" ? result.entityId : null;
  const notice = formatManagementNotice(result.notification);
  enqueueAgentMessage(db, { toUser: "group", text: notice }, now);
  // create/reassign hand the task to a NEW suggested owner (it stays "open",
  // never actually claimed yet). context.ownerId carries that userId when the
  // command assigned a hard owner directly, but "add_task" can just as
  // legitimately set a plain-name suggestedOwner instead (e.g. the model, or
  // Basim himself over WhatsApp, naming the person rather than resolving an
  // id) -- in that case context.ownerId is never populated, so fall back to
  // the task's own suggested_owner column, re-read fresh (this is a
  // brand-new row for "create", not in `state` at all yet) and resolved to a
  // userId the same way "claim" below already resolves one. Every other
  // notifying action (submit/approve/reject/archive/comment/blocker) leaves
  // an EXISTING owner unchanged; tasks.owner stores that owner as a NAME,
  // never a userId, so resolve it back through state.users. "claim" usually
  // makes the actor himself the owner (his own suggested task), which needs
  // no heads-up -- but a manager can also claim a task that was suggested to
  // someone ELSE (executeManagementAction only blocks this for non-managers),
  // silently taking it away from that colleague with no notice at all unless
  // caught here. `state` still holds the PRE-claim suggestedOwner (it was
  // read before this action executed), so that colleague can be resolved and
  // notified the same way reassign's new owner already is.
  const isHandoff = result.notification.action === "create" || result.notification.action === "reassign";
  const targetId = isHandoff
    ? context.ownerId ?? (() => {
        const suggested = taskId ? (db.prepare("SELECT suggested_owner AS suggestedOwner FROM tasks WHERE id=?").get(taskId) as { suggestedOwner: string | null } | undefined)?.suggestedOwner ?? null : null;
        return suggested ? state.users.find(u => u.name === suggested)?.id ?? null : null;
      })()
    : result.notification.action === "claim"
      ? (() => { const suggested = taskId ? state.tasks.find(t => t.id === taskId)?.suggestedOwner ?? null : null; return suggested && suggested !== actor.name ? state.users.find(u => u.name === suggested)?.id ?? null : null; })()
    : taskId
      ? (() => { const ownerName = state.tasks.find(t => t.id === taskId)?.owner ?? null; return ownerName ? state.users.find(u => u.name === ownerName)?.id ?? null : null; })()
      : null;
  // A handoff's whole point is delivering the tap-to-claim poll to whoever
  // was just suggested -- unlike every other action here, that still holds
  // even when the suggested owner turns out to be the actor himself (Basim,
  // or anyone, assigning a task to themselves by name): without this
  // exception he'd have created a task he can never see a CLAIM button for,
  // silently stuck "open" forever.
  if (targetId && (targetId !== actor.id || isHandoff)) {
    const targetName = state.users.find(u => u.id === targetId)?.name;
    // A fresh read, not `state` (this action just changed this exact task),
    // so create/reassign correctly offers CLAIM/TRANSFER on the now-open
    // task, not whatever taskActionPoll would have said before it moved.
    const choices = taskId && targetName ? freshTaskActionPoll(db, taskId, targetName, now) : undefined;
    enqueueAgentMessage(db, { toUser: targetId, text: `📌 تحديث على مهمتك:\n${notice}`, ...(choices ? { choices } : {}) }, now);
    notifyTaskLegend(db, targetId, now + 1, !choices);
  }
  // "تجيني أنا عشان أقرأها وتروح للغروب مشان يشوفوها" -- every task update
  // should reach Basim directly, not only the group broadcast. Skipped when
  // he is the one who just acted (no self-notice) or already the private
  // target above (he already got the richer version with the action poll).
  // "submit" is handled separately below -- it needs his actual DECISION,
  // never just an FYI, so it must never be skipped as a self-notice.
  if (result.notification.action !== "submit" && actor.id !== "basem" && targetId !== "basem") {
    enqueueAgentMessage(db, { toUser: "basem", text: notice }, now);
  }
  // A "submit" always needs Basim's actual decision, so -- unlike every
  // other action, gated above -- this must reach him even when he is the one
  // who just submitted (a task he does himself) or the task's own current
  // owner. Basim's report: "تجربة نسخة سكرتير مطور بانتظار اعتماد باسم مع
  // اني اقفلتها" -- he submitted his own task ("انهي مهمه"), which the
  // self-notice skip above silently swallowed, leaving it stuck "بانتظار
  // الاعتماد" with no poll and no way to ever act on it from WhatsApp.
  // requestTaskClose's text-typed close flow already attaches a real
  // approvalDecisionPoll via its own approvals-table row, but a submit that
  // reaches here (a FINISH tap above all, or Basim finishing his own task)
  // never created one, so without this there'd be no tap-based way to
  // approve/reject it at all. taskCloseDecisionPoll is the parallel,
  // approvals-table-free equivalent for exactly this case. This is the only
  // place a submit notifies basem -- the block above deliberately excludes
  // it to avoid a second, redundant message for the very same event.
  if (result.notification.action === "submit" && taskId) {
    enqueueAgentMessage(db, { toUser: "basem", text: notice, choices: taskCloseDecisionPoll(taskId, now) }, now);
  }
}
// On-demand "remind everyone now" broadcast (Basim asking directly, not the
// nightly agent-followups nudge cadence): groups every open, non-archived,
// non-completed task by its resolved OWNER (tasks.owner is a NAME, resolved
// back to a user the same way dispatchManagementNotice does), sends each
// owner their own list privately, and posts one combined group message with
// a 🔴 bold heading per owner -- WhatsApp text has no real color, so a bold
// name under a red-circle emoji is the closest stand-in for "highlight the
// responsible person in red" above their own tasks.
function ownerTaskGroups(state: Snapshot): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const task of state.tasks) {
    // Same "who is responsible" convention as numberedTaskList/secretaryTaskCard:
    // a claimed owner if there is one, otherwise the suggested owner -- an
    // open, unclaimed-but-suggested task still belongs on that person's
    // reminder, not nobody's.
    const responsible = task.owner || task.suggestedOwner;
    if (task.archivedAt || task.status === "completed" || !responsible) continue;
    const user = state.users.find(u => u.name === responsible);
    if (!user) continue;
    const list = groups.get(user.id) || []; list.push(task); groups.set(user.id, list);
  }
  return groups;
}
// Same "اليوم/بكرة/بعد بكرة/خلال أسبوع" bucketing as agent-followups.ts's
// reminderBuckets (kept local -- Task and ManagementTask are different
// shapes, and this file already can't import back from agent-followups.ts).
function reminderBuckets(tasks: Task[], today: string): Array<{ label: string; tasks: Task[] }> {
  const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const tomorrow = shift(1), dayAfter = shift(2), weekEnd = shift(7);
  const bucket = (task: Task) => !task.dueDate ? "بدون موعد محدد"
    : task.dueDate < today ? "🔴 متأخرة"
    : task.dueDate === today ? "اليوم"
    : task.dueDate === tomorrow ? "بكرة"
    : task.dueDate === dayAfter ? "بعد بكرة"
    : task.dueDate <= weekEnd ? "خلال أسبوع"
    : "لاحقًا";
  const order = ["🔴 متأخرة", "اليوم", "بكرة", "بعد بكرة", "خلال أسبوع", "لاحقًا", "بدون موعد محدد"];
  const groups = new Map<string, Task[]>();
  for (const task of tasks) { const key = bucket(task); const list = groups.get(key) || []; list.push(task); groups.set(key, list); }
  return order.filter(label => groups.has(label)).map(label => ({ label, tasks: groups.get(label)! }));
}
function formatOwnerTaskLines(tasks: Task[], today: string): string {
  return reminderBuckets(tasks, today).map(({ label, tasks: bucketed }) => `*${label}*\n` + bucketed.map((task, index) => {
    const priority = PRIORITIES[task.priority];
    const suffix = task.dueDate ? ` • ${clean(task.dueDate, 10)}` : "";
    return `${index + 1}. ${priority?.icon || "⚪"} ${clean(task.title, 120)} — ${LABELS[task.status] || clean(task.status)}${suffix}`;
  }).join("\n")).join("\n\n");
}
function sendTeamTaskReminders(db: DatabaseSync, state: Snapshot, now: number): { recipients: number } {
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const groups = ownerTaskGroups(state);
  let posted = 0;
  for (const [userId, tasks] of groups) {
    if (!tasks.length) continue;
    const user = state.users.find(u => u.id === userId)!;
    const lines = formatOwnerTaskLines(tasks, today);
    // A poll (see taskActionPoll) only ever fits one task per WhatsApp
    // message -- attach it when this reminder names exactly one.
    const choices = tasks.length === 1 ? taskActionPoll(tasks[0], user.name, now) : undefined;
    enqueueAgentMessage(db, { toUser: userId, text: `📋 تذكير بمهامك الحالية يا ${clean(user.name, 60)} (${tasks.length}):\n\n${lines}`, ...(choices ? { choices } : {}) }, now);
    // Basim asked for the group notice split into one message per person
    // (rather than one long combined message listing everyone), so each
    // owner's section is its own group post -- still headed by the same
    // 🔴 bold-name convention, just not concatenated together.
    enqueueAgentMessage(db, { toUser: "group", text: `📋 تذكير بالمهام المفتوحة — ${today}\n\n🔴 *${clean(user.name, 60).replace(/\*/g, "")}*\n${lines}` }, now);
    posted++;
  }
  return { recipients: posted };
}
function perform(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, command: Record<string, unknown>, now: number, context: Record<string, unknown>): Result {
  try {
    // A stashed edit_task can carry a "reason" (e.g. why a deadline moved) that
    // TaskFields/ACTION_KEYS has no column for -- executeManagementAction
    // rejects any command with a field outside ACTION_KEYS[action], so it must
    // be stripped from the edit_task command itself and applied afterward as
    // a separate, visible comment instead of being silently dropped.
    const { reason, ...editCommand } = command;
    const result = executeManagementAction(db, actor, editCommand as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: { ...context, senderNumber: event.senderNumber, origin: "whatsapp", proposedCommand: command } });
    if (command.action === "edit_task" && typeof command.taskId === "string" && typeof reason === "string" && reason.trim()) {
      executeManagementAction(db, actor, { action: "comment", taskId: command.taskId, comment: reason } as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: { ...context, senderNumber: event.senderNumber, origin: "whatsapp", proposedCommand: command } });
    }
    const taskId = typeof command.taskId === "string" ? command.taskId : result.entityType === "task" ? result.entityId : undefined;
    if (taskId) db.prepare("UPDATE secretary_reminders SET responded_at=? WHERE actor_id=? AND task_id=? AND group_id IS ? AND state='sent' AND responded_at IS NULL").run(now, actor.id, taskId, event.groupId);
    dispatchManagementNotice(db, actor, state, result, { ownerId: typeof command.ownerId === "string" ? command.ownerId : null }, now);
    const scope = taskId && state.tasks.some(t => t.id === taskId) && command.action !== "delete_task" ? ["t:" + taskId] : [];
    // Basim's command legend, right after any task action an EMPLOYEE (never
    // Basim himself) just did directly through chat -- claim/cancel_claim/
    // comment/submit are the only actions a non-admin ever reaches perform()
    // with (see the plan.kind==="command" gate above).
    notifyTaskLegend(db, actor.id, now);
    // File blobs from confirmed deletions remain recoverable on disk; DB links are removed atomically.
    return save(db, event, actor, { status: "applied", reply: `✅ ${result.message}`, ...(taskId ? { taskId } : {}) }, scope, now);
  } catch (error) {
    if (!(error instanceof ManagementActionError)) throw error;
    return save(db, event, actor, { status: "clarify", reply: error.message }, [], now);
  }
}

// Basim can now be a task's own worker (see stableOrdinal/ownershipCandidates
// above), not only its approver. "close_request" stashes this pseudo-action
// whenever the task isn't already "approval" so his one "موافق" walks it
// through every step it skipped -- claim (if still "open", never even
// claimed), submit (if "progress", claimed but never submitted), then
// approve -- instead of a bare "approve" action, which only ever accepts a
// task already sitting in "approval" and fails outright otherwise. Checks
// are against the ORIGINAL snapshot status (each step's own precondition
// still holds after an earlier step runs, since "open" only ever needs
// claim+submit and "progress" only ever needs submit).
function closeDirect(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskId: string, now: number, context: Record<string, unknown>): Result {
  try {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) throw new ManagementActionError(404, "task_missing", "المهمة غير موجودة أو غير متاحة لك");
    if (task.status === "open") executeManagementAction(db, actor, { action: "claim", taskId } as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: context });
    if (task.status === "open" || task.status === "progress") executeManagementAction(db, actor, { action: "submit", taskId } as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: context });
    const approved = executeManagementAction(db, actor, { action: "approve", taskId } as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: context });
    db.prepare("UPDATE secretary_reminders SET responded_at=? WHERE actor_id=? AND task_id=? AND group_id IS ? AND state='sent' AND responded_at IS NULL").run(now, actor.id, taskId, event.groupId);
    // Only the final approve is announced -- the claim/submit steps this
    // chains through are an implementation detail of "close it in one go",
    // not separate events worth their own group messages.
    dispatchManagementNotice(db, actor, state, approved, {}, now);
    return save(db, event, actor, { status: "applied", reply: `✅ ${approved.message}`, taskId }, ["t:" + taskId], now);
  } catch (error) {
    if (!(error instanceof ManagementActionError)) throw error;
    return save(db, event, actor, { status: "clarify", reply: error.message }, [], now);
  }
}
// "claim_multiple" (see secretary-intent.ts) resolves one or several list
// numbers against one numbered list and stashes this pseudo-action so
// Basim's single "موافق" actually claims every valid one for himself right
// now -- a real "claim" (open -> progress, owner set), not "reassign" (which
// only proposes and leaves the task open pending its own future acceptance,
// the right behavior for assigning to someone else, but wrong when he is
// taking it himself). A task that fails (already taken, deleted since the
// preview, etc.) is reported by name instead of aborting the whole batch --
// one bad number should never block the rest.
function claimMultiple(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskIds: string[], now: number, context: Record<string, unknown>): Result {
  const done: string[] = []; const failed: Array<{ title: string; reason: string }> = [];
  for (const taskId of taskIds) {
    const task = state.tasks.find(t => t.id === taskId);
    try {
      if (!task) throw new ManagementActionError(404, "task_missing", "المهمة غير موجودة أو غير متاحة لك");
      const claimed = executeManagementAction(db, actor, { action: "claim", taskId } as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: context });
      dispatchManagementNotice(db, actor, state, claimed, {}, now);
      done.push(task.title);
    } catch (error) {
      if (!(error instanceof ManagementActionError)) throw error;
      failed.push({ title: task?.title || taskId, reason: error.message });
    }
  }
  const scope = taskIds.filter(id => state.tasks.some(t => t.id === id)).map(id => "t:" + id);
  const reply = [done.length ? `✅ استلمت ${taskCountPhrase(done.length)}:\n${done.map(title => `• ${clean(title)}`).join("\n")}` : null,
    failed.length ? `تعذّر استلام:\n${failed.map(f => `• ${clean(f.title)}: ${f.reason}`).join("\n")}` : null].filter(Boolean).join("\n\n");
  if (done.length) notifyTaskLegend(db, actor.id, now);
  return save(db, event, actor, { status: done.length ? "applied" : "clarify", reply: reply || "ما قدرت أستلم ولا مهمة." }, scope, now);
}
function safeApprovals(db: DatabaseSync, actor: ChatUser) {
  try { return listApprovals(db, actor, { status: "pending", limit: 20 }).map(a => ({ id: a.id, type: a.type, summary: a.summary, requestedBy: a.requestedByName })); } catch { return []; }
}
function safeRules(db: DatabaseSync) {
  try { return activeRules(db).slice(0, 30).map(rule => ({ id: rule.id, statement: rule.statement })); } catch { return []; }
}
function safeKnowledge(db: DatabaseSync, actor: ChatUser, query: string) {
  try { return searchKnowledge(db, actor, query, 3); } catch { return []; }
}
/** Private notifications and group notices produced by agent actions go to the durable queue; the bridge delivers them. */
function deliverAgentSideEffects(db: DatabaseSync, actor: ChatUser, result: AgentResult, now: number) {
  for (const item of result.notify ?? []) if (item.userId !== actor.id) { enqueueAgentMessage(db, { toUser: item.userId, text: item.text, choices: item.choices }, now); notifyTaskLegend(db, item.userId, now + 1, !item.choices); }
  if (result.groupNotice) enqueueAgentMessage(db, { toUser: "group", text: result.groupNotice }, now);
}

