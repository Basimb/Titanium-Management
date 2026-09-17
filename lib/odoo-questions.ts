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
  | "sales_today" | "sales_yesterday" | "sales_week" | "sales_month"
  | "low_stock" | "expiring" | "unpaid_bills" | "purchases_month" | "help";
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
  { code: "NAOOR", names: ["الناعور", "ناعور", "النعور", "naoor"] },
  { code: "SAFOT", names: ["صافوط", "صفوط", "صافوت", "safot"] },
  { code: "JUMRK", names: ["الجمرك", "جمرك", "دوار الجمرك", "الجمارك", "jumrk"] },
  { code: "DABOQ", names: ["دابوق", "دبوق", "الدابوق", "daboq", "dabouq"] },
];
function matchBranch(text: string): string | null {
  for (const branch of BRANCH_ALIASES) {
    for (const name of branch.names) if (text.includes(normalizeArabic(name))) return branch.code;
  }
  return null;
}

// Basim (2026-09-17): "اربطه مباشر بالمصطلحات العربيه مشان يفهمني" -- he should
// not have to guess the one wording that works. So each question carries the
// words the team actually uses for it, in Jordanian Arabic, plus the English
// ones that show up in the system itself.
//
// Two kinds of matching, because Arabic makes a plain substring dangerous:
//   any   -- substring, for words long and distinctive enough that a false
//            positive is not realistic ("مبيعات" also catches "مبيعاتنا").
//   words -- whole word only, for short ones that live inside other words
//            ("دخل" would otherwise fire on "دخلت المخزن").
// `period` narrows an otherwise identical question to a time span: at least
// one of its words must appear, and the more specific span is listed first so
// "مبيعات امبارح" never falls into today's bucket.
type Pattern = { kind: OdooQuestionKind; any?: string[]; words?: string[]; period?: string[] };

const SALES_ANY = ["مبيعات", "المبيعات", "مبيعاتنا", "مبيعاتي", "بعنا", "بيعنا", "ايرادات", "الايرادات",
  "ايراد", "الايراد", "مدخول", "المدخول", "تحصيل", "التحصيل", "sales", "turnover"];
const SALES_WORDS = ["بيع", "البيع", "دخل", "الدخل", "كاش", "الكاش"];

const PATTERNS: Pattern[] = [
  // Asked first, so "شو بتعرف تجاوب؟" is answered with the list rather than
  // with whichever word happened to appear in the question.
  { kind: "help", any: ["شو بتعرف تجاوب", "شو بتعرف ترد", "شو بقدر اسالك", "شو بقدر اسال", "شو الاسئله",
    "قائمه الاسئله", "شو بتفهم", "شو بتعرف تعمل", "كيف اسالك", "شو ممكن اسالك"], words: ["مساعده", "help"] },

  { kind: "expiring", any: ["منتهي الصلاحيه", "منتهيه الصلاحيه", "الصلاحيه", "صلاحيه", "صلاحيات",
    "بتنتهي", "بينتهي", "ينتهي", "قرب ينتهي", "قاربه على الانتهاء", "تواريخ الانتهاء", "اكسباير",
    "expiry", "expiring", "expired"] },

  // The state of the bill is what makes this question, not the word "فاتوره" --
  // which belongs just as much to the purchases question below.
  { kind: "unpaid_bills", any: ["مش مدفوع", "مش مدفوعه", "غير مدفوع", "غير مدفوعه", "غير مسدد", "مش مسدد",
    "ما دفعنا", "لسه ما دفعنا", "مستحقات", "مستحق للمورد", "ذمم", "الذمم", "مديونيه", "مديونيات",
    "علينا للمورد", "علينا للموردين", "كم علينا", "مطلوب مننا", "دائنين", "unpaid", "payables"] },

  { kind: "purchases_month", any: ["مشتريات", "المشتريات", "اشترينا", "شرينا", "مرتجعات للمورد",
    "مرتجعات الموردين", "purchases"] },

  { kind: "low_stock", any: ["نواقص", "النواقص", "ناقصه", "قارب على النفاد", "قربت تخلص", "قرب يخلص",
    "قربت تنفد", "تحت الحد", "المخزون", "مخزون", "ستوك", "كميات قليله", "شحيح", "stock"],
    words: ["ناقص", "خلص", "خالص", "نفد", "نفذ"] },

  { kind: "sales_yesterday", any: SALES_ANY, words: SALES_WORDS, period: ["امبارح", "مبارح", "البارحه", "امس", "الامس"] },
  { kind: "sales_week", any: SALES_ANY, words: SALES_WORDS, period: ["الاسبوع", "اسبوع", "هالاسبوع", "اسبوعي"] },
  { kind: "sales_month", any: SALES_ANY, words: SALES_WORDS, period: ["الشهر", "هالشهر", "شهري", "الشهري"] },
  { kind: "sales_today", any: SALES_ANY, words: SALES_WORDS },
];

// Whether it is worth asking the model to route this at all. The hand-written
// patterns above already answer the common wordings for free; this gate decides
// which of the leftovers are worth one cheap model call, so an ordinary message
// ("ذكّر أحمد بالطلبية") never pays for one. A question mark, or a question word
// standing on its own, is the whole test -- deliberately loose, because the
// router's own answer for anything else is "none".
const QUESTION_WORDS = ["كم", "شو", "قديش", "اديش", "كيف", "وين", "ايش", "شقد", "هل", "اعطيني",
  "جيبلي", "طلعلي", "وريني", "بدي اعرف", "ممكن اعرف", "how", "what"];
export function looksLikeOdooQuestion(text: string): boolean {
  if (!text || text.length > 200) return false;
  if (/[؟?]/.test(text)) return true;
  const value = normalizeArabic(text);
  if (!value) return false;
  const tokens = value.split(" ");
  return QUESTION_WORDS.some(word => {
    const normalized = normalizeArabic(word);
    return normalized.includes(" ") ? value.includes(normalized) : tokens.includes(normalized);
  });
}

/** The question this message is asking, or null when it is not one of them. */
export function matchOdooQuestion(text: string): OdooQuestionMatch | null {
  const value = normalizeArabic(text);
  if (!value || value.length > 200) return null;
  const tokens = value.split(" ");
  for (const pattern of PATTERNS) {
    if (pattern.period && !pattern.period.some(word => value.includes(normalizeArabic(word)))) continue;
    const hit = (pattern.any ?? []).some(word => value.includes(normalizeArabic(word)))
      || (pattern.words ?? []).some(word => tokens.includes(normalizeArabic(word)));
    if (!hit) continue;
    return { kind: pattern.kind, branch: matchBranch(value) };
  }
  return null;
}

// The answer to "شو بتعرف تجاوب؟", in the wording the questions themselves
// take. It is a constant on purpose: it lists what is really wired up, so it
// can never promise a question that is not in PATTERNS above.
const HELP_REPLY = [
  "🤖 *بقدر أجاوبك على:*",
  "",
  "📊 *المبيعات* — «شو مبيعات اليوم» · «مبيعات امبارح» · «مبيعات الأسبوع» · «مبيعات الشهر»",
  "🏪 *لفرع لحاله* — زيد اسم الفرع: «مبيعات الناعور اليوم»",
  "   (الناعور · صافوط · دابوق · الجمرك)",
  "📦 *النواقص* — «شو ناقص من المخزون»",
  "⏳ *الصلاحيات* — «شو بينتهي قريب» · «في إشي منتهي؟»",
  "🧾 *فواتير الموردين* — «كم علينا مش مدفوع»",
  "🛒 *المشتريات* — «شو المشتريات هالشهر»",
  "",
  "كل رقم بيجي من دواء تك مباشرة، ما بألّفه.",
].join("\n");

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

export type OdooAnswerConfig = { odoo: OdooConfig; currencyLabel?: string; expiryWindowDays?: number; fetcher?: typeof fetch };

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
  if (match.kind === "help") return HELP_REPLY;
  const session = await openOdooSession(config.odoo, config.fetcher);
  const currency = config.currencyLabel;
  if (match.kind === "sales_today" || match.kind === "sales_yesterday" || match.kind === "sales_week" || match.kind === "sales_month") {
    // "آخر ٧ أيام" rather than "since Sunday": the week he means is the last
    // seven days of trading, and a label that says exactly which days were
    // counted can never be read as a different week than the one summed.
    const weekFrom = startOfLocalDay(at) - 6 * DAY;
    const [from, to, heading] = match.kind === "sales_today"
      ? [startOfLocalDay(at), at, `📊 *مبيعات اليوم لحد الآن* (${dateLabel(at)})`]
      : match.kind === "sales_yesterday"
        ? [startOfLocalDay(at) - DAY, startOfLocalDay(at), `📊 *مبيعات أمس* (${dateLabel(startOfLocalDay(at) - DAY)})`]
        : match.kind === "sales_week"
          ? [weekFrom, at, `📊 *مبيعات آخر ٧ أيام* (من ${dateLabel(weekFrom)} إلى ${dateLabel(at)})`]
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
    const summary = await session.expirySummary(days, at);
    return [
      "⏳ *الصلاحيات*",
      "",
      `🔴 منتهية وموجودة بالمخزن: *${summary.expiredQty}* قطعة (${summary.expiredLines} سطر)`,
      `🟡 بتنتهي خلال ${days} يوم: *${summary.soonQty}* قطعة (${summary.soonLines} سطر)`,
    ].join("\n");
  }
  if (match.kind === "unpaid_bills") {
    const summary = await session.openPayables();
    if (!summary.billCount) return "🧾 ما في فواتير موردين غير مسدّدة.";
    const lines = ["🧾 *فواتير موردين غير مسدّدة*", "",
      `العدد: *${summary.billCount}* فاتورة`, `المتبقّي: *${money(summary.billTotal, currency)}*`];
    // An unpaid credit note reduces what is actually owed, so leaving it out
    // reads high. Shown only when there is one, and the net beside it.
    if (summary.creditCount) {
      lines.push(`↩️ إشعارات خصم غير مطبّقة: *${money(summary.creditTotal, currency)}* من ${summary.creditCount} إشعار`,
        "━━━━━━━━━━━━━", `💰 *الصافي علينا*: ${money(summary.billTotal - summary.creditTotal, currency)}`);
    }
    return lines.join("\n");
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
  // Not "under ten units" -- on the live catalogue that is 80% of everything
  // with stock, because a pharmacy carries one or two of most things. What is
  // running out is what will be gone within the week at the rate it sells.
  const items = await session.shortages({ maxDaysLeft: 7, limit: 15, at });
  if (!items.length) return "📦 ما في صنف متحرّك رح يخلص خلال أسبوع.";
  return [
    "📦 *رح تخلص خلال أسبوع*",
    "",
    ...items.map(item => `• ${item.name} — باقي *${Math.round(item.daysLeft * 10) / 10}* يوم (${item.qty} قطعة، ${item.perDay.toFixed(1)}/يوم)`),
  ].join("\n");
}
