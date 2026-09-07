/**
 * Agent behaviours layered on the secretary. The model only proposes a kind and
 * fields; everything here re-checks identity and permission on the server,
 * files durable approvals, and never mutates without the action engine.
 */
import type { DatabaseSync } from "node:sqlite";
import { decideApproval, findPendingApproval, formatPendingList, listApprovals, requestDeadlineExtension, requestProjectCreate, requestTaskClose, approvalTypeLabel, type Approval } from "./approvals.ts";
import { executeManagementAction, ManagementActionError, type ManagementActor } from "./management-actions.ts";
import { addKnowledge, formatKnowledgeHits, searchKnowledge } from "./knowledge.ts";
import { activeRules, formatRules, policyViolations, proposeRuleFromStatement, recordCorrection, suggestOwner } from "./rules.ts";
import { can, isOwner, type PermissionActor } from "./permissions.ts";
import type { SecretaryIntent } from "./secretary-intent.ts";

export type AgentResult = { status: string; reply: string; taskId?: string; groupNotice?: string | null; notify?: Array<{ userId: string; text: string }> };
export type AgentContext = {
  db: DatabaseSync; actor: ManagementActor; now: number; inputKind?: string | null; suppressNotices?: boolean;
  users: Array<{ id: string; name: string; active?: number }>; tasks: Array<{ id: string; title: string; projectId: string; status: string; owner: string | null; dueDate: string | null }>;
  projects: Array<{ id: string; name: string; status: string }>;
  /** Store a pending command for the existing confirmation flow (token returned). */
  stash: (command: Record<string, unknown>) => string;
};
const clean = (value: unknown, max = 200) => String(value ?? "").replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, max);
const ORDINALS: Record<string, number> = { "الاول": 1, "الأول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };
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
  return { status: "applied", reply: `✅ أنشأت مشروع «${clean(bundle.name)}» مع ${count} مهام.${bundle.suppressNotices ? " بدون إرسال إشعارات للفريق." : ""}`, groupNotice: bundle.suppressNotices ? null : `📁 مشروع جديد: ${clean(bundle.name)}${lines.length ? `\n${lines.join("\n")}` : ""}` };
}

/** Execute a confirmed decision (owner, voice path) — called from the confirmation flow. */
export function applyDecision(db: DatabaseSync, actor: ManagementActor, input: { approvalId: string; decision: "approved" | "rejected"; note?: string }, now: number): AgentResult {
  const decision = decideApproval(db, actor, input, { now });
  return { status: "applied", reply: `✅ ${decision.approval.status === "approved" ? "اعتمدت" : "رفضت"} ${approvalTypeLabel(decision.approval.type)}: ${decision.approval.summary}`, groupNotice: decision.notifyGroup, notify: [{ userId: decision.approval.requestedBy, text: decision.notifyRequester }] };
}

export function handleAgentIntent(plan: SecretaryIntent, ctx: AgentContext): AgentResult | null {
  const { db, actor, now } = ctx;
  const owner = isOwner(actor as PermissionActor);
  const voice = ctx.inputKind === "voice";
  try {
    switch (plan.kind) {
      case "approvals": {
        const pending = listApprovals(db, actor, { status: "pending" });
        if (owner) return { status: "summary", reply: formatPendingList(pending) };
        if (!pending.length) return { status: "summary", reply: "ما عندك طلبات معلّقة عند باسم حاليًا." };
        return { status: "summary", reply: `طلباتك بانتظار قرار باسم:\n${pending.map((approval, index) => `${index + 1}. ${approvalTypeLabel(approval.type)} — ${approval.summary}`).join("\n")}` };
      }
      case "decide": {
        if (!can(actor as PermissionActor, "approval.decide")) return { status: "denied", reply: "القرار على الطلبات لباسم فقط." };
        const hint = clean(plan.message, 200);
        const pending = listApprovals(db, actor, { status: "pending" });
        let target: Approval | null = null;
        const ordinal = Object.entries(ORDINALS).find(([word]) => hint.includes(word))?.[1];
        if (ordinal && pending[ordinal - 1]) target = pending[ordinal - 1];
        else {
          const requester = ctx.users.find(user => hint.includes(user.name))?.name ?? null;
          const found = findPendingApproval(db, actor, { requesterName: requester, text: hint });
          if (found.approval) target = found.approval;
          else if (found.candidates.length > 1) return { status: "clarify", reply: `في أكثر من طلب مطابق:\n${found.candidates.map((approval, index) => `${index + 1}. ${approvalTypeLabel(approval.type)} — ${approval.summary} (${approval.requestedByName})`).join("\n")}\nقل «اعتمد الأول» أو حدد الطلب.` };
        }
        if (!target) return { status: "clarify", reply: pending.length ? `ما قدرت أحدد الطلب المقصود.\n${formatPendingList(pending)}` : "ما في طلبات بانتظار قرارك حاليًا." };
        const decision = plan.action === "approve" ? "approved" : "rejected";
        const note = clean(plan.fields.reason, 2000) || undefined;
        if (voice) {
          const token = ctx.stash({ action: "decide_approval", approvalId: target.id, decision, note });
          return { status: "confirmation", reply: `فهمت من الصوت أنك ${decision === "approved" ? "تعتمد" : "ترفض"}: ${approvalTypeLabel(target.type)} — ${target.summary}${note ? `\nالملاحظة: ${note}` : ""}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء».` };
        }
        return applyDecision(db, actor, { approvalId: target.id, decision, note }, now);
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
          const token = ctx.stash({ action: "approve", taskId: task.id });
          return { status: "confirmation", reply: `اعتماد إغلاق «${clean(task.title)}».\nاكتب «موافق ${token}» للتنفيذ.`, taskId: task.id };
        }
        const request = requestTaskClose(db, actor, { taskId: task.id, result }, { now });
        return { status: "applied", reply: `✅ سجّلت النتيجة ورفعت «${clean(task.title)}» لاعتماد باسم. بخبرك بقراره.`, taskId: task.id, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: `📤 ${actor.name} أنهى «${clean(task.title)}» وبانتظار اعتماد باسم` };
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
        if (!can(actor as PermissionActor, "project.create")) return { status: "denied", reply: "فتح المشاريع لباسم ومديري الأقسام." };
        const name = clean(plan.fields.name, 240); const goal = clean(plan.fields.details, 2000);
        const parsed = parseProjectTaskLines(plan.message, ctx.users);
        if (!parsed.tasks.length) return { status: "clarify", reply: `تمام، مشروع «${name}». شو المهام اللي بدك تحطها فيه، ومين المسؤول عن كل وحدة، وأي وحدة عاجلة (حمراء)؟` };
        for (const task of parsed.tasks) {
          if (!task.ownerId) { const suggestion = suggestOwner(db, { text: task.title }); if (suggestion) task.ownerId = suggestion.ownerId; }
        }
        const violations = parsed.tasks.flatMap(task => policyViolations(db, { title: task.title, dueDate: task.dueDate, ownerId: task.ownerId }));
        const preview = describeProjectBundle(name, goal, parsed.tasks, ctx.users);
        const warnings = [...parsed.problems, ...violations].map(problem => `⚠️ ${problem}`).join("\n");
        if (owner) {
          const token = ctx.stash({ action: "create_project_bundle", name, goal, tasks: parsed.tasks, suppressNotices: ctx.suppressNotices === true });
          return { status: "confirmation", reply: `${voice ? "فهمت من الصوت:\n" : ""}${preview}${warnings ? `\n${warnings}` : ""}${ctx.suppressNotices ? "\nبدون إرسال إشعارات للفريق." : ""}\n\nأعتمد إنشاء المشروع؟ اكتب «موافق ${token}» أو صحّح أي بند.` };
        }
        const request = requestProjectCreate(db, actor, { name, goal, tasks: parsed.tasks }, { now });
        return { status: "applied", reply: `📨 رفعت اقتراح المشروع «${name}» لباسم للاعتماد.`, notify: [{ userId: "basem", text: request.ownerMessage }], groupNotice: null };
      }
      default: return null;
    }
  } catch (error) {
    if (error instanceof ManagementActionError) return { status: "clarify", reply: error.message };
    throw error;
  }
}

export function rulesSummary(db: DatabaseSync): string { return formatRules(activeRules(db)); }

