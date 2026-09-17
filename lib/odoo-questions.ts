/**
 * Live questions about the pharmacy's own Odoo system, answered from real
 * numbers rather than from the model.
 *
 * Basim asked for this as "اسأله لايف ويجاوب" -- but the same evening he had
 * spent removing the model from every tap decision ("مشان نتجاوز مشكلة
 * الذكاء"), so letting it translate a free-text question into an arbitrary
 * query would have put the guessing right back, this time into numbers he
 * would act on. Instead: a fixed set of questions, matched here by their
 * Arabic wording, each bound to one specific query. A question outside the
 * set matches nothing and falls through to the ordinary secretary, which is
 * the honest answer -- never an invented figure.
 */
import { openOdooSession, formatAmount, type OdooConfig } from "./odoo-client.ts";

export type OdooQuestionKind =
  | "sales_today" | "sales_yesterday" | "sales_month"
  | "low_stock" | "expiring" | "unpaid_bills" | "purchases_month";
export type OdooQuestionMatch = { kind: OdooQuestionKind; branch: string | null };

const DAY = 24 * 60 * 60_000;
const AMMAN_OFFSET_MINUTES = 180;

// Arabic as it is actually typed on a phone: no diacritics, ه for ة, ي for ى,
// and the hamza forms folded together. Every matcher below runs on the
// normalized form, so "المبيعات" and "مبيعات" and "مبيعاتنا" all land the same.
export function normalizeArabic(value: string): string {
  return value.normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim().toLowerCase();
}

// Branch names as the team says them, mapped to the location code Odoo uses.
// The codes come from the live system (NAOOR/Stock, SAFOT/Stock, ...).
const BRANCH_ALIASES: Array<{ code: string; names: string[] }> = [
  { code: "NAOOR", names: ["الناعور", "ناعور", "naoor"] },
  { code: "SAFOT", names: ["صافوط", "صفوط", "safot"] },
  { code: "JUMRK", names: ["الجمرك", "جمرك", "دوار الجمرك", "jumrk"] },
  { code: "DABOQ", names: ["دابوق", "داबوق", "daboq", "dabouq"] },
];
function matchBranch(text: string): string | null {
  for (const branch of BRANCH_ALIASES) {
    for (const name of branch.names) if (text.includes(normalizeArabic(name))) return branch.code;
  }
  return null;
}

// Each entry is "this question, in the ways it gets asked". Order matters:
// the more specific period wins, so "مبيعات امبارح" never falls into the
// plain "مبيعات" (today) bucket.
const PATTERNS: Array<{ kind: OdooQuestionKind; any: string[]; all?: string[] }> = [
  { kind: "expiring", any: ["منتهي الصلاحيه", "منتهيه الصلاحيه", "الصلاحيه", "بتنتهي", "ينتهي", "قرب ينتهي", "قاربه على الانتهاء", "expiry", "expiring"] },
  // "كم فاتورة مورد مش مدفوعة" and "الفواتير غير المدفوعة" are the same
  // question -- match the state words, not one exact plural.
  { kind: "unpaid_bills", any: ["مش مدفوع", "غير مدفوع", "غير مسدد", "مش مسدد", "مستحقات", "ذمم", "مديونيه", "علينا للمورد", "كم علينا"] },
  { kind: "purchases_month", any: ["مشتريات"], },
  { kind: "low_stock", any: ["ناقص", "نواقص", "خالص", "قارب على النفاد", "المخزون", "مخزون"] },
  { kind: "sales_yesterday", any: ["مبيعات", "بعنا", "المبيعات"], all: ["امبارح"] },
  { kind: "sales_month", any: ["مبيعات", "بعنا", "المبيعات"], all: ["الشهر"] },
  { kind: "sales_today", any: ["مبيعات", "بعنا", "المبيعات", "مبيعاتنا"] },
];

/** The question this message is asking, or null when it is not one of them. */
export function matchOdooQuestion(text: string): OdooQuestionMatch | null {
  const value = normalizeArabic(text);
  if (!value || value.length > 200) return null;
  for (const pattern of PATTERNS) {
    if (pattern.all && !pattern.all.every(word => value.includes(normalizeArabic(word)))) continue;
    if (!pattern.any.some(word => value.includes(normalizeArabic(word)))) continue;
    return { kind: pattern.kind, branch: matchBranch(value) };
  }
  return null;
}

function startOfLocalDay(at: number): number {
  const shifted = new Date(at + AMMAN_OFFSET_MINUTES * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - AMMAN_OFFSET_MINUTES * 60_000;
}
function startOfLocalMonth(at: number): number {
  const shifted = new Date(at + AMMAN_OFFSET_MINUTES * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - AMMAN_OFFSET_MINUTES * 60_000;
}
const dateLabel = (at: number) => new Date(at + AMMAN_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

const BRANCH_NAMES: Record<string, string> = { NAOOR: "الناعور", SAFOT: "صافوط", DABOQ: "دابوق", JUMRK: "الجمرك" };
const COLORS = ["🟢", "🔵", "🟡", "🔴", "🟣", "🟠"];
const branchLabel = (location: string) => BRANCH_NAMES[location.split("/")[0]?.trim().toUpperCase() ?? ""] || location;
const money = (value: number, label?: string) => label ? `${formatAmount(value)} ${label}` : formatAmount(value);

export type OdooAnswerConfig = { odoo: OdooConfig; currencyLabel?: string; lowStockThreshold?: number; expiryWindowDays?: number; fetcher?: typeof fetch };

// Basim (2026-09-17): "بدي يصير جاوبني بسرعه فائقه". The same question asked
// twice in a row -- which is what happens when he checks, then shows someone,
// then checks again -- costs one trip to Odoo instead of two. The window is
// deliberately short: a minute of staleness is invisible on a running daily
// total, and anything longer would start answering a question about "الآن"
// with a number from a noticeably different moment. The key carries the day
// label, so the answer is never reused across midnight.
const ANSWER_TTL_MS = 60_000;
const answerCache = new Map<string, { text: string; at: number }>();

/** Test seam: forget every cached answer, so a test starts from a clean slate. */
export function forgetOdooAnswers(): void { answerCache.clear(); }

/** Answers one matched question. Throws OdooError if the system is unreachable. */
export async function answerOdooQuestion(match: OdooQuestionMatch, config: OdooAnswerConfig, at: number): Promise<string> {
  const key = `${config.odoo.url}|${config.odoo.db}|${match.kind}|${match.branch ?? ""}|${dateLabel(at)}`;
  const cached = answerCache.get(key);
  if (cached && at - cached.at >= 0 && at - cached.at < ANSWER_TTL_MS) return cached.text;
  const text = await freshAnswer(match, config, at);
  // Bounded: the question set is fixed and small, but a long-running process
  // should never accumulate keys from days it has already left behind.
  if (answerCache.size > 64) answerCache.clear();
  answerCache.set(key, { text, at });
  return text;
}

async function freshAnswer(match: OdooQuestionMatch, config: OdooAnswerConfig, at: number): Promise<string> {
  const session = await openOdooSession(config.odoo, config.fetcher);
  const currency = config.currencyLabel;
  if (match.kind === "sales_today" || match.kind === "sales_yesterday" || match.kind === "sales_month") {
    const [from, to, heading] = match.kind === "sales_today"
      ? [startOfLocalDay(at), at, `📊 *مبيعات اليوم لحد الآن* (${dateLabel(at)})`]
      : match.kind === "sales_yesterday"
        ? [startOfLocalDay(at) - DAY, startOfLocalDay(at), `📊 *مبيعات أمس* (${dateLabel(startOfLocalDay(at) - DAY)})`]
        : [startOfLocalMonth(at), at, `📊 *مبيعات الشهر* (من ${dateLabel(startOfLocalMonth(at))})`];
    const rows = await session.salesByLocation(new Date(from).toISOString(), new Date(to).toISOString());
    const picked = match.branch ? rows.filter(row => row.location.split("/")[0]?.toUpperCase() === match.branch) : rows;
    if (!picked.length) return `${heading}\n\nما في مبيعات مسجّلة${match.branch ? ` لفرع ${BRANCH_NAMES[match.branch]}` : ""} لهاي الفترة.`;
    const total = picked.reduce((sum, row) => sum + row.totalAmount, 0);
    const orders = picked.reduce((sum, row) => sum + row.orderCount, 0);
    const ranked = [...picked].sort((a, b) => b.totalAmount - a.totalAmount);
    const lines = [heading, ""];
    ranked.forEach((row, index) => {
      const pct = total > 0 ? (row.totalAmount / total) * 100 : 0;
      lines.push(`${COLORS[index % COLORS.length]} *${branchLabel(row.location)}* — ${money(row.totalAmount, currency)} (${pct.toFixed(1)}%)`);
    });
    lines.push("", "━━━━━━━━━━━━━", `💰 *الإجمالي*: ${money(total, currency)} من ${orders} عملية`);
    return lines.join("\n");
  }
  if (match.kind === "expiring") {
    const days = config.expiryWindowDays ?? 90;
    const summary = await session.expirySummary(days);
    return [
      "⏳ *الصلاحيات*",
      "",
      `🔴 منتهية وموجودة بالمخزن: *${summary.expiredQty}* قطعة (${summary.expiredLines} سطر)`,
      `🟡 بتنتهي خلال ${days} يوم: *${summary.soonQty}* قطعة (${summary.soonLines} سطر)`,
    ].join("\n");
  }
  if (match.kind === "unpaid_bills") {
    const summary = await session.openPayables();
    return summary.billCount
      ? `🧾 *فواتير موردين غير مسدّدة*\n\nالعدد: *${summary.billCount}* فاتورة\nالمتبقّي: *${money(summary.billTotal, currency)}*`
      : "🧾 ما في فواتير موردين غير مسدّدة.";
  }
  if (match.kind === "purchases_month") {
    const since = dateLabel(startOfLocalMonth(at)), until = dateLabel(at);
    const summary = await session.purchaseSummary(since, until);
    const net = summary.purchaseAmount - summary.returnAmount;
    return [
      "🧾 *المشتريات من أول الشهر*",
      `📅 من ${since} إلى ${until}`,
      "",
      `🛒 المشتريات: ${money(summary.purchaseAmount, currency)} من ${summary.purchaseCount} فاتورة`,
      `↩️ مرتجعات للموردين: ${money(summary.returnAmount, currency)} من ${summary.returnCount} إشعار`,
      "━━━━━━━━━━━━━",
      `💰 *الصافي*: ${money(net, currency)}`,
    ].join("\n");
  }
  const threshold = config.lowStockThreshold ?? 10;
  const items = await session.lowStock(threshold, 15);
  if (!items.length) return `📦 ما في أصناف تحت ${threshold} قطعة.`;
  return [`📦 *أصناف قاربت على النفاد* (أقل من ${threshold})`, "", ...items.map(item => `• ${item.name} — ${item.qty}`)].join("\n");
}
