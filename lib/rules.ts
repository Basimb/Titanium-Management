import type { DatabaseSync } from "node:sqlite";
import { requestRule, type Approval } from "./approvals.ts";
import { migrateManagementActions, resolveManagementActor, type ManagementActor } from "./management-actions.ts";
import { can, type PermissionActor } from "./permissions.ts";

export type Rule = { id: string; kind: "assignment" | "policy" | "note"; statement: string; match: { keywords?: string[]; projectId?: string | null; category?: string | null }; effect: { suggestOwner?: string | null; requireDueDate?: boolean; requireOwner?: boolean; watcher?: string | null }; active: number; approvedBy: string; createdAt: number };
export const CORRECTION_THRESHOLD = 3;

export const normalizeArabic = (value: string) => value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase();

function hydrate(row: Record<string, unknown>): Rule {
  const parse = (value: unknown) => { try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } };
  return { ...(row as unknown as Rule), match: parse(row.match), effect: parse(row.effect) };
}

export function activeRules(db: DatabaseSync): Rule[] {
  migrateManagementActions(db);
  return (db.prepare("SELECT id,kind,statement,match,effect,active,approved_by AS approvedBy,created_at AS createdAt FROM rules WHERE active=1 ORDER BY created_at").all() as Record<string, unknown>[]).map(hydrate);
}

/** Rules whose keywords appear in the text (title/details) or that apply to the project. */
export function matchingRules(db: DatabaseSync, input: { text: string; projectId?: string | null; category?: string | null }): Rule[] {
  const haystack = normalizeArabic(input.text);
  return activeRules(db).filter(rule => {
    const keywords = (rule.match.keywords ?? []).map(normalizeArabic).filter(Boolean);
    const byKeyword = keywords.length > 0 && keywords.some(keyword => haystack.includes(keyword));
    const byProject = !!rule.match.projectId && rule.match.projectId === input.projectId;
    const byCategory = !!rule.match.category && !!input.category && normalizeArabic(rule.match.category) === normalizeArabic(input.category);
    return byKeyword || byProject || byCategory;
  });
}

/** Deterministic suggestion the agent may offer before creating a task. Never auto-applied. */
export function suggestOwner(db: DatabaseSync, input: { text: string; projectId?: string | null }): { ownerId: string; rule: Rule } | null {
  for (const rule of matchingRules(db, input)) if (rule.kind === "assignment" && rule.effect.suggestOwner) return { ownerId: rule.effect.suggestOwner, rule };
  return null;
}

/** Policy checks the server enforces at creation time (after owner approval of the policy). */
export function policyViolations(db: DatabaseSync, draft: { title: string; projectId?: string | null; dueDate?: string | null; ownerId?: string | null }): string[] {
  const problems: string[] = [];
  for (const rule of activeRules(db).filter(rule => rule.kind === "policy")) {
    if (rule.effect.requireDueDate && !draft.dueDate) problems.push(`القاعدة: ${rule.statement} — المهمة بلا موعد`);
    if (rule.effect.requireOwner && !draft.ownerId) problems.push(`القاعدة: ${rule.statement} — المهمة بلا مسؤول`);
  }
  return problems;
}

/**
 * Record a correction ("لا، شادي مش أيمن") and, when the same correction repeats
 * CORRECTION_THRESHOLD times, file a rule proposal for the owner. Nothing becomes
 * a rule without an explicit owner decision.
 */
export function recordCorrection(db: DatabaseSync, claimed: ManagementActor, input: { category: "assignment" | "priority" | "other"; from: string | null; to: string | null; context: string; keywords?: string[] }, options: { now?: number } = {}): { count: number; proposal: { approval: Approval; ownerMessage: string } | null } {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "rule.propose") && !can(actor as PermissionActor, "rule.approve")) return { count: 0, proposal: null };
  const at = options.now ?? Date.now();
  const keywords = (input.keywords ?? []).map(word => normalizeArabic(word.trim())).filter(word => word.length > 1).slice(0, 8);
  const signature = `${input.category}:${normalizeArabic(input.from ?? "")}>${normalizeArabic(input.to ?? "")}:${keywords.slice().sort().join("|")}`;
  db.prepare("INSERT INTO corrections (category,signature,from_value,to_value,context,corrected_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(input.category, signature, input.from, input.to, input.context.slice(0, 1000), actor.id, at);
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM corrections WHERE signature=? AND proposed_rule_id IS NULL").get(signature)?.n ?? 0);
  if (count < CORRECTION_THRESHOLD) return { count, proposal: null };
  const alreadyPending = db.prepare("SELECT id FROM approvals WHERE status='pending' AND type='rule' AND summary LIKE ?").get(`%${(input.to ?? "").slice(0, 40)}%`);
  if (alreadyPending) return { count, proposal: null };
  const statement = input.category === "assignment"
    ? `مهام ${keywords.length ? keywords.join("، ") : "من هذا النوع"} تكون لـ${input.to ?? "المسؤول المصحح"} بدل ${input.from ?? "غيره"}`
    : `تصحيح متكرر (${input.category}): ${input.from ?? "-"} → ${input.to ?? "-"}`;
  const proposal = requestRule(db, actor, { kind: input.category === "assignment" ? "assignment" : "note", statement, match: { keywords }, effect: input.category === "assignment" ? { suggestOwner: input.to } : {} }, { now: at });
  db.prepare("UPDATE corrections SET proposed_rule_id=? WHERE signature=? AND proposed_rule_id IS NULL").run(proposal.approval.id, signature);
  return { count, proposal: { ...proposal, ownerMessage: `لاحظت أنك صححت هذا ${count} مرات: ${input.from ?? "-"} → ${input.to ?? "-"}.\nهل تعتمد القاعدة التالية؟\n${statement}\n\n(اعتمد / ارفض)` } };
}

/** Explicit owner statement: "أي مهمة حكومية لدابوق خليها لخالد" → proposal the owner then confirms. */
export function proposeRuleFromStatement(db: DatabaseSync, claimed: ManagementActor, input: { statement: string; keywords: string[]; suggestOwner?: string | null; projectId?: string | null; policy?: { requireDueDate?: boolean; requireOwner?: boolean } }, options: { now?: number } = {}) {
  const isPolicy = !!input.policy && Object.keys(input.policy).length > 0;
  return requestRule(db, claimed, { kind: isPolicy ? "policy" : input.suggestOwner ? "assignment" : "note", statement: input.statement, match: { keywords: input.keywords.map(word => normalizeArabic(word)).filter(Boolean), projectId: input.projectId ?? null }, effect: isPolicy ? input.policy : { suggestOwner: input.suggestOwner ?? null } }, options);
}

export function deactivateRule(db: DatabaseSync, claimed: ManagementActor, ruleId: string, options: { now?: number } = {}): boolean {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "rule.approve")) return false;
  return Number(db.prepare("UPDATE rules SET active=0,updated_at=? WHERE id=? AND active=1").run(options.now ?? Date.now(), ruleId).changes) === 1;
}

export function formatRules(rules: Rule[]): string {
  if (!rules.length) return "لا توجد قواعد معتمدة بعد.";
  return `القواعد المعتمدة:\n${rules.map((rule, index) => `${index + 1}. ${rule.statement}`).join("\n")}`;
}
