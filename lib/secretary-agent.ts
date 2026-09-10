/**
 * Agent behaviours layered on the secretary. The model only proposes a kind and
 * fields; everything here re-checks identity and permission on the server,
 * files durable approvals, and never mutates without the action engine.
 */
import type { DatabaseSync } from "node:sqlite";
import { decideApproval, findPendingApproval, formatApprovalChoice, formatPendingList, listApprovals, patchTaskCreateApproval, requestDeadlineExtension, requestProjectClose, requestProjectCreate, requestTaskClose, requestTaskOwnership, requestTaskTransfer, approvalTypeLabel, type Approval } from "./approvals.ts";
import { executeManagementAction, ManagementActionError, type ManagementActor } from "./management-actions.ts";
import { addKnowledge, formatKnowledgeHits, searchKnowledge } from "./knowledge.ts";
import { activeRules, formatRules, policyViolations, proposeRuleFromStatement, recordCorrection, suggestOwner } from "./rules.ts";
import { can, isOwner, type PermissionActor } from "./permissions.ts";
import type { SecretaryIntent } from "./secretary-intent.ts";
import { createSecretaryChoices, type SecretaryChoices } from "./secretary-choices.ts";

export type AgentResult = { status: string; reply: string; taskId?: string; projectId?: string; groupNotice?: string | null; notify?: Array<{ userId: string; text: string }>; choices?: SecretaryChoices };
export type AgentContext = {
  db: DatabaseSync; actor: ManagementActor; now: number; inputKind?: string | null; suppressNotices?: boolean;
  // The admin's own raw WhatsApp text, when available -- see the "decide"
  // case's use of it below for why this must be the verbatim message and
  // never the model-produced plan.message.
  text?: string | null;
  // Present only for a real, tappable-poll-eligible conversation (Basim's own
  // private chat -- see secretary-service.ts's call site, which mirrors
  // intakeChoices' own `event.groupId === null` gate). Absent/empty means
  // "no live poll possible here" and every choice-builder below degrades to
  // its existing text-only reply, exactly as it did before this field existed.
  conversationKey?: string;
  users: Array<{ id: string; name: string; active?: number }>; tasks: Array<{ id: string; title: string; projectId: string; status: string; owner: string | null; dueDate: string | null }>;
  projects: Array<{ id: string; name: string; status: string }>;
  /** Store a pending command for the existing confirmation flow (token returned). */
  stash: (command: Record<string, unknown>) => string;
};
const clean = (value: unknown, max = 200) => String(value ?? "").replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, max);
const ORDINALS: Record<string, number> = { "الاول": 1, "الأول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };
// Arabic count agreement for "مهمة" -- 1 and 2 have their own words, 3-10
// take the plural, 11+ reverts to the singular after the number. Duplicated from
// secretary-service.ts's taskCountPhrase to avoid a circular import between the two.
const taskCountPhrase = (n: number) => n === 1 ? "مهمة واحدة" : n === 2 ? "مهمتين" : n <= 10 ? `${n} مهام` : `${n} مهمة`;
export type ProjectDraftTask = { title: string; ownerId: string | null; priority: "red" | "yellow" | "green"; dueDate: string | null };

export function parseProjectTaskLines(message: string | null, users: AgentContext["users"]): { tasks: ProjectDraftTask[]; problems: string[] } {
  const tasks: ProjectDraftTask[] = []; const problems: string[] = [];
  for (const raw of (message ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 40)) {
    const [title = "", owner = "-", priority = "yellow", due = "-"] = raw.split("|").map(part => part.trim());
    if (!title) continue;
    const ownerId = owner && owner !== "-" ? users.find(user => user.id === owner || user.name === owner)?.id ?? null : null;
    if (owner && owner !== "-" && !ownerId) problems.push(`ما عرفت الموظف «${clean(owner, 40)}» للمهمة «${clean(title, 60)}»`);
    const level = ["red", "yellow", "green"].includes(priority) ? priority as ProjectDraftTask["priority"] : /احمر|أحمر|حمرا|red|عاجل/u.test(priority) ? "red" : /اخضر|أخضر|خضرا|green|عادي/u.test(priority) ? "green" : "yellow";
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null;
    tasks.push({ title: clean(title, 240), ownerId, priority: level, dueDate });
  }
  return { tasks, problems };
}

export function describeProjectBundle(name: string, goal: string, tasks: ProjectDraftTask[], users: AgentContext["users"]): string {
  const nameOf = (id: string | null) => id ? users.find(user => user.id === id)?.name ?? id : "غير معيّن";
  const level: Record<string, string> = { red: "🔴 عاجلة", yellow: "🟡 مهمة", green: "🟢 عادية" };
  return `هذا ملخص المشروع قبل الإنشاء:\nالاسم: ${clean(name)}${goal ? `\nالهدف: ${clean(goal, 300)}` : ""}\nالمهام (${tasks.length}):\n${tasks.map((task, index) => `${index + 1}. ${task.title} — ${nameOf(task.ownerId)} — ${level[task.priority]}${task.dueDate ? ` — ${task.dueDate}` : ""}`).join("\n") || "لا توجد مهام بعد"}`;
}

/** Execute a confirmed project bundle (owner) — called from the confirmation flow. */
export function createProjectBundle(db: DatabaseSync, actor: ManagementActor, bundle: { name: string; goal: string; tasks: ProjectDraftTask[]; suppressNotices?: boolean }, now: number, context: Record<string, unknown>): AgentResult {
  const created = executeManagementAction(db, actor, { action: "add_project", name: bundle.name }, { now, source: "whatsapp_secretary", auditContext: context });
  let count = 0;
  for (const task of bundle.tasks) {
    executeManagementAction(db, actor, { action: "add_task", projectId: created.entityId, title: task.title, details: bundle.goal ? `الهدف: ${bundle.goal}` : "", priority: task.priority, dueDate: task.dueDate, ownerId: task.ownerId }, { now: now + 1 + count, source: "whatsapp_secretary", auditContext: context });
    count += 1;
  }
  const nameOf = (id: string | null) => id ? String(db.prepare("SELECT name FROM users WHERE id=?").get(id)?.name ?? id) : null;
  const lines = bundle.tasks.map(task => `${nameOf(task.ownerId) ?? "غير معيّن"}: ${task.title} — ${task.priority === "red" ? "أحمر" : task.priority === "yellow" ? "أصفر" : "أخضر"}${task.dueDate ? ` — ${task.dueDate}` : ""}`);
  return { status: "applied", projectId: created.entityId,
    reply: `✅ أنشأت مشروع «${clean(bundle.name)}»${count ? ` مع ${taskCountPhrase(count)}` : ""}.${bundle.suppressNotices ? " بدون إرسال إشعارات للفريق." : ""}\nاحكيلي أي مهمة كمان بمشروع «${clean(bundle.name)}» عادي وبربطها فيه تلقائيًا.`,
    groupNotice: bundle.suppressNotices ? null : `📁 مشروع جديد: ${clean(bundle.name)}${lines.length ? `\n${lines.join("\n")}` : ""}` };
}

/** Execute a confirmed "بدون مشروع" task (owner only) — called from the
 * confirmation flow. Every task still needs a project row (project_id is
 * NOT NULL), so this creates a throwaway wrapper project named literally
 * "بدون مشروع" and marks it is_standalone (Feature: schema + auto-close in
 * management-actions.ts's "approve" case archives it invisibly once its one
 * task is done) -- from the user's side this reads as a plain standalone
 * task, never as "a project was created". Modeled closely on
 * createProjectBundle above but for exactly one task, and always silent
 * (no group notice) since there is no real project to announce. */
export function createStandaloneTask(db: DatabaseSync, actor: ManagementActor, task: ProjectDraftTask & { details?: string }, now: number, context: Record<string, unknown>): AgentResult {
  const created = executeManagementAction(db, actor, { action: "add_project", name: "بدون مشروع" }, { now, source: "whatsapp_secretary", auditContext: context });
  db.prepare("UPDATE projects SET is_standalone=1 WHERE id=?").run(created.entityId);
  const added = executeManagementAction(db, actor, { action: "add_task", projectId: created.entityId, title: task.title, details: task.details || "", priority: task.priority, dueDate: task.dueDate, ownerId: task.ownerId }, { now: now + 1, source: "whatsapp_secretary", auditContext: context });
  return { status: "applied", taskId: added.entityId, projectId: created.entityId, reply: `✅ أضفت مهمة: ${clean(task.title)}.`, groupNotice: null };
}

/** Execute a confirmed decision (owner, voice path) — called from the confirmation flow. */
export function applyDecision(db: DatabaseSync, actor: ManagementActor, input: { approvalId: string; decision: "approved" | "rejected"; note?: string }, now: number): AgentResult {
  const decision = decideApproval(db, actor, input, { now });
  const notify = [{ userId: decision.approval.requestedBy, text: decision.notifyRequester }, ...decision.notifyExtra];
  return { status: "applied", reply: `✅ ${decision.approval.status === "approved" ? "اعتمدت" : "رفضت"} ${approvalTypeLabel(decision.approval.type)}: ${decision.approval.summary}`, groupNotice: decision.notifyGroup, notify };
}

// Basim's stated complaint: several pending approvals arrive as text-only
// 🟢/🔴 instructions ("اعتمد 1"/"ارفض 2") with nothing to actually tap, and
// he loses track of which number is which request. Whenever one of his own
// live replies already shows one or more pending approvals as a decision
// surface (the "approvals" owner listing below, and "decide"'s
// ambiguous-multi-candidate/no-target fallbacks), attach a real tappable
// poll with one ✅/❌ pair per request -- tapping resolves that exact
// approval regardless of how many others are pending, with no number to
// pick. Bounded to the existing 12-option/createSecretaryChoices cap (6
// approvals × 2 decisions); beyond that, or outside a private reply this
// admin can actually tap (see AgentContext.conversationKey), this quietly
// returns undefined and callers keep their existing text-only reply --
// exactly like intakeChoices' own fallback for the same table.
function approvalDecisionChoices(db: DatabaseSync, ctx: AgentContext, pending: Approval[]): SecretaryChoices | undefined {
  if (!ctx.conversationKey || ctx.actor.id !== "basem" || !pending.length || pending.length > 6) return undefined;
  const options = pending.flatMap(approval => [
    { label: `✅ اعتماد — ${approvalTypeLabel(approval.type)}: ${approval.summary}`, value: `${approval.id}|Y` },
    { label: `❌ رفض — ${approvalTypeLabel(approval.type)}: ${approval.summary}`, value: `${approval.id}|N` },
  ]);
  try {
    return createSecretaryChoices(db, { conversationKey: ctx.conversationKey, actorId: ctx.actor.id, draftVersion: "approvalDecision", catalogHash: "approvalDecision",
      field: "approvalDecision", title: "اختار القرار", options, now: ctx.now, expiresAt: ctx.now + 30 * 60_000 });
  } catch { return undefined; }
}

export function handleAgentIntent(plan: SecretaryIntent, ctx: AgentContext): AgentResult | null {
  const { db, actor, now } = ctx;
  const owner = isOwner(actor as PermissionActor);
  const voice = ctx.inputKind === "voice";
  try {
    switch (plan.kind) {
      case "approvals": {
        const pending = listApprovals(db, actor, { status: "pending" });
        if (owner) { const choices = approvalDecisionChoices(db, ctx, pending); return { status: "summary", reply: formatPendingList(pending), ...(choices ? { choices } : {}) }; }
        if (!pending.length) return { status: "summary", reply: "ما عندك طلبات معلّقة عند باسم حاليًا." };
        return { status: "summary", reply: `طلباتك بانتظار قرار باسم:\n${pending.map((approval, index) => `${index + 1}. ${approvalTypeLabel(approval.type)} — ${approval.summary}`).join("\n")}` };
      }
      case "decide": {
        if (!can(actor as PermissionActor, "approval.decide")) return { status: "denied", reply: "القرار على الطلبات لباسم فقط." };
        const pending = listApprovals(db, actor, { status: "pending" });
        if (!pending.length) return { status: "clarify", reply: "ما في طلبات بانتظار قرارك حاليًا." };
        const decision = plan.action === "approve" ? "approved" : "rejected";
        const note = clean(plan.fields.reason, 2000) || undefined;
        // The model's own free-text `message` field for this intent is its
        // paraphrase of what Basim said, not a guaranteed verbatim copy --
        // it can drop the exact ordinal word/number he typed ("الاول"),
        // which made every retry loop back to the same "أكثر من طلب مطابق"
        // clarify no matter what he said next. ctx.text is the actual raw
        // message; check it first and only fall back to the model's message.
        const rawText = clean(ctx.text ?? "", 200);
        const hint = clean(plan.message, 200);
        const combined = rawText || hint;
        // "ارفض الكل"/"اعتمد الكل": decide every pending request in one go.
        // Basim asked for this directly after hitting the ordinal bug above
        // on repeat -- when several unrelated requests are pending, forcing
        // him through them one numbered clarify at a time isn't always what
        // he wants, and "الكل" was never a recognized word to begin with, so
        // it silently fell into the same ambiguous-candidates clarify too.
        if (!voice && /(?:الكل|كلها|كلهم|جميعها|جميعهم)/.test(combined)) {
          const notify: Array<{ userId: string; text: string }> = [];
          const groupNotices: string[] = [];
          const lines: string[] = [];
          for (const approval of pending) {
            const result = decideApproval(db, actor, { approvalId: approval.id, decision, note }, { now });
            notify.push({ userId: result.approval.requestedBy, text: result.notifyRequester }, ...result.notifyExtra);
            if (result.notifyGroup) groupNotices.push(result.notifyGroup);
            lines.push(`• ${approvalTypeLabel(result.approval.type)} — ${result.approval.summary} (${result.approval.requestedByName})`);
          }
          return { status: "applied", reply: `${decision === "approved" ? "✅ اعتمدت" : "❌ رفضت"} ${pending.length} ${pending.length === 1 ? "طلب" : "طلبات"}:\n${lines.join("\n")}`, groupNotice: groupNotices.length ? groupNotices.join("\n") : null, notify };
        }
        let target: Approval | null = null;
        const ordinalFrom = (source: string) => Object.entries(ORDINALS).find(([word]) => source.includes(word))?.[1];
        const ordinal = ordinalFrom(rawText) ?? ordinalFrom(hint);
        if (ordinal && pending[ordinal - 1]) target = pending[ordinal - 1];
        else {
          const requester = ctx.users.find(user => combined.includes(user.name))?.name ?? null;
          const found = findPendingApproval(db, actor, { requesterName: requester, text: combined });
          if (found.approval) target = found.approval;
          // Same per-item 🟢/🔴 block + blank-line separation as formatPendingList
          // (see its comment) -- this is the other place several pending
          // requests can land in one message, and it must look the same way.
          else if (found.candidates.length > 1) {
            const choices = approvalDecisionChoices(db, ctx, found.candidates);
            return { status: "clarify", reply: `في أكثر من طلب مطابق:\n\n${found.candidates.map((approval, index) => formatApprovalChoice(approval, index)).join("\n\n")}\n\nاختر رقم الطلب، أو قل «اعتمد الكل» أو «ارفض الكل».`, ...(choices ? { choices } : {}) };
          }
        }
        if (!target) {
          const choices = approvalDecisionChoices(db, ctx, pending);
          return { status: "clarify", reply: `ما قدرت أحدد الطلب المقصود.\n${formatPendingList(pending)}`, ...(choices ? { choices } : {}) };
        }
        // Basim may correct a still-pending task-open request in the very
        // message he decides it ("اعتمد بس خلها حمراء ومدتها يومين") --
        // patch the request before deciding so the corrected values are what
        // gets created. Only task_create supports this today.
        let correctionNote = "";
        if (target.type === "task_create" && (plan.fields.priority || plan.fields.dueDate)) {
          patchTaskCreateApproval(db, actor, { approvalId: target.id, priority: plan.fields.priority ?? undefined, dueDate: plan.fields.dueDate ?? undefined }, { now });
          const priorityLabel = plan.fields.priority === "red" ? "🔴 عاجلة" : plan.fields.priority === "yellow" ? "🟡 متوسطة" : plan.fields.priority === "green" ? "🟢 عادية" : null;
          correctionNote = `${priorityLabel ? ` الأولوية: ${priorityLabel}.` : ""}${plan.fields.dueDate ? ` الموعد: ${plan.fields.dueDate}.` : ""}`;
        }
        if (voice) {
          const token = ctx.stash({ action: "decide_approval", approvalId: target.id, decision, note });
          return { status: "confirmation", reply: `فهمت من الصوت أنك ${decision === "approved" ? "تعتمد" : "ترفض"}: ${approvalTypeLabel(target.type)} — ${target.summary}${correctionNote ? `\nعدّلت قبل التنفيذ:${correctionNote}` : ""}${note ? `\nالملاحظة: ${note}` : ""}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء».` };
        }
        const result = applyDecision(db, actor, { approvalId: target.id, decision, note }, now);
        return correctionNote ? { ...result, reply: `${result.reply}\n(بعد تعديلك:${correctionNote})` } : result;
      }
      case "extension": {
        const task = ctx.tasks.find(candidate => candidate.id === plan.taskId);
        if (!task) return { status: "clarify", reply: "أي مهمة تقصد؟" };
        const reason = clean(plan.fields.reason, 1000) || "لم يُذكر سبب";
        if (owner) {
          const token = ctx.stash({ action: "edit_task", taskId: task.id, dueDate: plan.fields.dueDate });
          return { status: "confirmation", reply: `تعديل موعد «${clean(task.title)}» إلى ${plan.fields.dueDate}.\nاكتب «موافق ${token}» للتنفيذ.`, taskId: task.id };
        }
        const request = requestDeadlineExtension(db, actor, { taskId: task.id, newDueDate: String(plan.fields.dueDate), reason }, { now });
        return { status: "applied", reply: `📨 رفعت طلب التمديد لباسم: ${request.approval.summary}\nالسبب: ${reason}\nبخبرك أول ما يقرر.`, taskId: task.id, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      case "close_request": {
        const task = ctx.tasks.find(candidate => candidate.id === plan.taskId);
        if (!task) return { status: "clarify", reply: "أي مهمة خلصت؟" };
        const result = clean(plan.fields.details, 4000) || clean(plan.message, 4000);
        if (!result) return { status: "clarify", reply: `شو نتيجة «${clean(task.title)}» بالضبط؟ تم التوقيع/التسليم؟ في ملف أو صورة؟ في شي متبقي؟`, taskId: task.id };
        if (owner) {
          if (task.status === "completed") return { status: "clarify", reply: `«${clean(task.title)}» معتمدة خلص.`, taskId: task.id };
          // "approve" only ever applies to a task already sitting in approval
          // (an employee submitted it). Basim can also be the task's own
          // worker now, in which case it may still be "open" (never even
          // claimed) or "progress" (claimed, never submitted) -- so
          // close_direct chains whichever of claim/submit/approve is
          // missing in one confirmed step, instead of a bare approve that
          // would fail on either of those preconditions.
          const token = ctx.stash(task.status === "approval" ? { action: "approve", taskId: task.id } : { action: "close_direct", taskId: task.id });
          return { status: "confirmation", reply: `اعتماد إغلاق «${clean(task.title)}».\nاكتب «موافق ${token}» للتنفيذ.`, taskId: task.id };
        }
        const request = requestTaskClose(db, actor, { taskId: task.id, result }, { now });
        return { status: "applied", reply: `✅ سجّلت النتيجة ورفعت «${clean(task.title)}» لاعتماد باسم. بخبرك بقراره.`, taskId: task.id, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: `📤 ${actor.name} أنهى «${clean(task.title)}» وبانتظار اعتماد باسم` };
      }
      case "ownership_request": {
        if (owner) return { status: "clarify", reply: "أنت تقدر تعيّن المسؤول مباشرة. اذكر المهمة واسم الموظف." };
        if (!plan.taskId) return { status: "clarify", reply: "أي مهمة بدك تستلم مسؤوليتها؟" };
        const request = requestTaskOwnership(db, actor, { taskId: plan.taskId, reason: clean(plan.fields.reason, 1000) }, { now });
        return { status: "applied", reply: `📨 رفعت طلبك لباسم: ${request.approval.summary}. ما تغير المسؤول قبل موافقته.`, taskId: plan.taskId, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      case "task_transfer_request": {
        if (owner) return { status: "clarify", reply: "أنت تقدر تعيد تعيين المهمة مباشرة. اذكر المهمة واسم الموظف الجديد." };
        if (!plan.taskId) return { status: "clarify", reply: "أي مهمة بدك تحوّل أو تعتذر عنها؟" };
        const suggestedOwnerId = plan.fields.ownerId || null;
        const request = requestTaskTransfer(db, actor, { taskId: plan.taskId, suggestedOwnerId, reason: clean(plan.fields.reason, 1000) }, { now });
        const reply = suggestedOwnerId
          ? `📨 رفعت طلب التحويل لباسم: ${request.approval.summary}. ما تغير المسؤول قبل موافقته.`
          : `📨 رفعت لباسم إنها مش مسؤوليتك. ما تغير شي قبل قراره.`;
        return { status: "applied", reply, taskId: plan.taskId, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      case "project_close_request": {
        if (owner) return { status: "clarify", reply: "أنت تقدر تغلق المشروع مباشرة. اذكر اسمه." };
        if (!plan.projectId) return { status: "clarify", reply: "أي مشروع بدك تغلق؟" };
        const project = ctx.projects.find(candidate => candidate.id === plan.projectId);
        const request = requestProjectClose(db, actor, { projectId: plan.projectId, reason: clean(plan.fields.reason, 1000) }, { now });
        return { status: "applied", reply: `📨 رفعت طلب إغلاق مشروع «${clean(project?.name ?? "")}» لباسم. بخبرك بقراره.`, projectId: plan.projectId, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      case "rule": {
        if (!owner) return { status: "denied", reply: "القواعد الدائمة يعتمدها باسم." };
        const statement = clean(plan.fields.body, 1000);
        const keywords = clean(plan.message, 300).split(/[،,]/).map(word => word.trim()).filter(Boolean);
        const policy = plan.fields.reason === "require_due_date" ? { requireDueDate: true } : plan.fields.reason === "require_owner" ? { requireOwner: true } : undefined;
        const suggest = plan.fields.ownerId && ctx.users.some(user => user.id === plan.fields.ownerId) ? plan.fields.ownerId : null;
        const proposal = proposeRuleFromStatement(db, actor, { statement, keywords, suggestOwner: suggest, policy }, { now });
        void proposal;
        return { status: "summary", reply: `سجّلت القاعدة كاقتراح بانتظار اعتمادك:\n«${statement}»${keywords.length ? `\nالنطاق: ${keywords.join("، ")}` : ""}\n\nقل «اعتمد القاعدة» لتفعيلها أو «ارفض».` };
      }
      case "correction": {
        if (!owner) return { status: "denied", reply: "التصحيحات الدائمة من باسم فقط." };
        const to = plan.fields.ownerId && ctx.users.some(user => user.id === plan.fields.ownerId) ? plan.fields.ownerId : null;
        if (!to) return { status: "clarify", reply: "مين المسؤول الصحيح؟ اذكر اسمه." };
        const fromName = clean(plan.fields.name, 60) || null;
        const keywords = clean(plan.message, 300).split(/[،,]/).map(word => word.trim()).filter(Boolean);
        const toName = ctx.users.find(user => user.id === to)?.name ?? to;
        const outcome = recordCorrection(db, actor, { category: "assignment", from: fromName, to: toName, context: clean(plan.message, 300), keywords }, { now });
        const base = `سجّلت التصحيح: ${fromName ? `${fromName} → ` : ""}${toName}${keywords.length ? ` (${keywords.join("، ")})` : ""}.`;
        if (outcome.proposal) return { status: "summary", reply: `${base}\n\n${outcome.proposal.ownerMessage}` };
        const task = ctx.tasks.find(candidate => candidate.id === plan.taskId);
        return { status: "summary", reply: `${base}${task ? `\nبدك أعيد تعيين «${clean(task.title)}» إلى ${toName} الآن؟ قل «عيّنها لـ${toName}».` : ""}`, ...(task ? { taskId: task.id } : {}) };
      }
      case "knowledge": {
        if (plan.fields.title && plan.fields.body) {
          if (!can(actor as PermissionActor, "knowledge.write")) return { status: "denied", reply: "إضافة معلومات لقاعدة المعرفة لباسم ومديري الأقسام." };
          const entry = addKnowledge(db, actor, { title: clean(plan.fields.title, 200), body: clean(plan.fields.body, 20_000) }, { now });
          return { status: "applied", reply: `📚 حفظت في قاعدة المعرفة: ${entry.title}` };
        }
        const query = clean(plan.message, 300);
        if (!query) return { status: "clarify", reply: "شو المعلومة اللي بتدور عليها؟" };
        const hits = searchKnowledge(db, actor, query, 4);
        if (!hits.length) return { status: "summary", reply: `ما لقيت شي عن «${query}» في قاعدة المعرفة الداخلية. إذا معلومة عامة قلّي «ابحث» وأبحث لك على الإنترنت.` };
        return { status: "summary", reply: `من قاعدة المعرفة:\n\n${formatKnowledgeHits(hits)}` };
      }
      case "project_draft": {
        // Any authenticated actor may propose a project (approval.request, which
        // every role has) -- only the DIRECT no-approval creation path below is
        // restricted, and that already only ever runs for the owner (Basim).
        // A blanket project.create gate here used to block plain members from
        // even filing the request, contradicting the intended design (DM-only
        // project/task proposals from staff, same as task_draft).
        const name = clean(plan.fields.name, 240); const goal = clean(plan.fields.details, 2000);
        const parsed = parseProjectTaskLines(plan.message, ctx.users);
        // Never ask a second question here (e.g. "what tasks go in it?") --
        // project_draft has no saved state across turns, so a follow-up
        // question here is exactly the loop bug reported live: the project
        // name gets lost if the next message doesn't restate it. Finalize on
        // this single turn (with whatever tasks were given, possibly none)
        // and let further tasks come in one at a time through the normal,
        // stateful task_draft flow, which remembers this project automatically.
        for (const task of parsed.tasks) {
          if (!task.ownerId) { const suggestion = suggestOwner(db, { text: task.title }); if (suggestion) task.ownerId = suggestion.ownerId; }
        }
        const violations = parsed.tasks.flatMap(task => policyViolations(db, { title: task.title, dueDate: task.dueDate, ownerId: task.ownerId }));
        const preview = describeProjectBundle(name, goal, parsed.tasks, ctx.users);
        const warnings = [...parsed.problems, ...violations].map(problem => `⚠️ ${problem}`).join("\n");
        const taskNote = parsed.tasks.length ? "" : `\n\nبعد ما ينفتح، احكيلي أي مهمة بمشروع «${name}» عادي وبربطها فيه تلقائيًا.`;
        if (owner) {
          const token = ctx.stash({ action: "create_project_bundle", name, goal, tasks: parsed.tasks, suppressNotices: ctx.suppressNotices === true });
          return { status: "confirmation", reply: `${voice ? "فهمت من الصوت:\n" : ""}${preview}${warnings ? `\n${warnings}` : ""}${ctx.suppressNotices ? "\nبدون إرسال إشعارات للفريق." : ""}${taskNote}\n\nأعتمد إنشاء المشروع؟ اكتب «موافق ${token}» أو صحّح أي بند.` };
        }
        const request = requestProjectCreate(db, actor, { name, goal, tasks: parsed.tasks }, { now });
        return { status: "applied", reply: `📨 رفعت اقتراح المشروع «${name}» لباسم للاعتماد.${taskNote}`, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      default: return null;
    }
  } catch (error) {
    if (error instanceof ManagementActionError) return { status: "clarify", reply: error.message };
    throw error;
  }
}

export function rulesSummary(db: DatabaseSync): string { return formatRules(activeRules(db)); }

