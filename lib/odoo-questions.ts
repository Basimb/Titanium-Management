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
import { openOdooSession, formatAmount, type OdooConfig, type ShortageItem } from "./odoo-client.ts";

export type OdooQuestionKind =
  | "sales_today" | "sales_yesterday" | "sales_week" | "sales_month"
  | "shifts_today" | "shifts_yesterday" | "shifts_week" | "shifts_month"
  | "low_stock" | "expiring" | "unpaid_bills" | "purchases_month" | "data_quality" | "help";
// `shift` is set when the question names ONE of them -- "الشفت الصباحي", or the
// hours written out as "من ٨ الصباح لـ٤ العصر". Null means all three.
export type OdooQuestionMatch = { kind: OdooQuestionKind; branch: string | null; shift?: "morning" | "evening" | "night" | null };

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

const SHIFT_WORDS = ["شفت", "الشفت", "شفتات", "الشفتات", "ورديه", "وردية", "ورديات", "الورديات", "shift", "shifts"];

// Basim asked for a shift by the clock, not by its name: "من ال 8 الصباح ل 4
// العصر". So the hours themselves have to be readable, in both digit sets, and
// so do the names people use for the same three windows.
const SHIFT_NAMES: Array<{ shift: "morning" | "evening" | "night"; any: string[] }> = [
  { shift: "morning", any: ["الصباحي", "صباحي", "الصباحيه", "شفت الصباح", "وردية الصباح", "morning"] },
  { shift: "evening", any: ["المسائي", "مسائي", "المسائيه", "شفت المسا", "وردية المسا", "شفت العصر", "evening"] },
  { shift: "night", any: ["الليلي", "ليلي", "الليليه", "شفت الليل", "وردية الليل", "night"] },
];
const SHIFT_HOURS: Array<{ shift: "morning" | "evening" | "night"; from: number; to: number }> = [
  { shift: "morning", from: 8, to: 4 }, { shift: "evening", from: 4, to: 12 }, { shift: "night", from: 12, to: 8 },
];
const westernDigits = (value: string) => value.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

/** Which single shift this wording names, or null for all three. */
export function matchShiftName(text: string): "morning" | "evening" | "night" | null {
  const value = westernDigits(normalizeArabic(text));
  for (const named of SHIFT_NAMES) {
    if (named.any.some(word => value.includes(normalizeArabic(word)))) return named.shift;
  }
  // "من 8 ... ل 4 ..." -- the first two standalone numbers, read as the hours.
  const hours = (value.match(/(?<![\d])([01]?\d|2[0-4])(?![\d])/g) ?? []).map(Number);
  if (hours.length >= 2) {
    for (const window of SHIFT_HOURS) {
      if (hours[0] === window.from && hours[1] === window.to) return window.shift;
    }
  }
  return null;
}

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

  // Basim (2026-09-20), starting an audit of the pharmacy's Odoo: "بدنا نحلل
  // منصه اودو تبعت الصيدليه ونشوف وين الاخطاء"، then "وخلي هذا الملف كمان نربطو
  // بالسكرتير يستفيد منو". Asked BEFORE low_stock: "ناقص بيانات" is about the
  // catalogue, not about stock, and the more specific reading has to win.
  { kind: "data_quality", any: ["نظافه البيانات", "نظافه الداتا", "جوده البيانات", "اخطاء البيانات",
    "بيانات ناقصه", "ناقص بيانات", "ناقصه بيانات", "بدون باركود", "بلا باركود", "باركود",
    "اصناف مكرره", "منتجات مكرره", "مكرره", "مكرر", "بدون سعر", "بدون تكلفه", "سعر التكلفه",
    "مخزون سالب", "كميه سالبه", "فحص الاصناف", "تدقيق الاصناف"] },
  { kind: "low_stock", any: ["نواقص", "النواقص", "ناقصه", "قارب على النفاد", "قربت تخلص", "قرب يخلص",
    "قربت تنفد", "تحت الحد", "المخزون", "مخزون", "ستوك", "كميات قليله", "شحيح", "stock"],
    words: ["ناقص", "خلص", "خالص", "نفد", "نفذ"] },

  // Basim (2026-09-17): the branches run three shifts -- 08:00-16:00, 16:00-24:00
  // and 00:00-08:00. Asked ahead of the plain sales questions, because "مبيعات
  // الشفتات امبارح" is a shift question that happens to contain the word for
  // sales, and the more specific reading has to win.
  { kind: "shifts_yesterday", any: SHIFT_WORDS, period: ["امبارح", "مبارح", "البارحه", "امس", "الامس", "لامبارح"] },
  { kind: "shifts_week", any: SHIFT_WORDS, period: ["الاسبوع", "اسبوع", "هالاسبوع", "للاسبوع", "لاسبوع", "بالاسبوع", "اسبوعي"] },
  { kind: "shifts_month", any: SHIFT_WORDS, period: ["الشهر", "هالشهر", "للشهر", "لشهر", "بالشهر", "شهري", "الشهري"] },
  { kind: "shifts_today", any: SHIFT_WORDS },

  { kind: "sales_yesterday", any: SALES_ANY, words: SALES_WORDS, period: ["امبارح", "مبارح", "البارحه", "امس", "الامس", "لامبارح"] },
  { kind: "sales_week", any: SALES_ANY, words: SALES_WORDS, period: ["الاسبوع", "اسبوع", "هالاسبوع", "للاسبوع", "لاسبوع", "بالاسبوع", "اسبوعي"] },
  { kind: "sales_month", any: SALES_ANY, words: SALES_WORDS, period: ["الشهر", "هالشهر", "للشهر", "لشهر", "بالشهر", "شهري", "الشهري"] },
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
    const shift = matchShiftName(text);
    // A sales question that names a shift IS a shift question, even when the
    // word for shift never appears: "البيع من ال 8 الصباح ل 4 العصر".
    const kind = shift && pattern.kind.startsWith("sales_")
      ? (pattern.kind.replace("sales_", "shifts_") as OdooQuestionKind)
      : pattern.kind;
    return { kind, branch: matchBranch(value), shift };
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
  "🧹 *نظافة البيانات* — «فحص الأصناف» · «مين بدون باركود» · «أصناف مكررة»",
  "⏳ *الصلاحيات* — «شو بينتهي قريب» · «في إشي منتهي؟»",
  "🕐 *الشفتات* — «شفتات امبارح» · «شفت المسا بالناعور»",
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

// Basim, 2026-09-21, reading the report on his phone: "هيو انا عربي كيف
// اقرا هذا". Every product name here is English and every measurement is
// Arabic, and WhatsApp lays a mixed line out by its own bidi rules -- the
// dash lands in the middle, the numbers jump, and a long name wraps with the
// Arabic stranded on the far side. One line each fixes it: the name alone
// reads left-to-right, the measurement alone reads right-to-left, and the
// number in front gives him something to point at.
//
// A combined item's piece count mixes packs with loose pieces, so it says so
// instead of printing a count nobody can act on.
function shortageLines(item: ShortageItem, index: number): string[] {
  const days = Math.round(item.daysLeft * 10) / 10;
  const detail = item.combined ? "علب + تجزئة"
    : `${item.qty} قطعة، ${item.perDay.toFixed(1)}/يوم`;
  return [`${index + 1}. ${item.name}`, `باقي *${days}* يوم — ${detail}`, ""];
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
  if (match.kind.startsWith("shifts_")) {
    const midnight = startOfLocalDay(at);
    const [from, to, when] = match.kind === "shifts_today" ? [midnight, at, "اليوم"]
      : match.kind === "shifts_yesterday" ? [midnight - DAY, midnight, "أمس"]
      : match.kind === "shifts_week" ? [midnight - 6 * DAY, at, "آخر ٧ أيام"]
      : [startOfLocalMonth(at), at, "الشهر"];
    const shifts = await session.salesByShift(from, to, AMMAN_OFFSET_MINUTES);
    const forBranch = (rows: Array<{ location: string; orderCount: number; totalAmount: number }>) =>
      match.branch ? rows.filter(row => row.location.split("/")[0]?.toUpperCase() === match.branch) : rows;
    const picked = shifts
      .filter(shift => !match.shift || shift.shift === match.shift)
      .map(shift => {
        const rows = forBranch(shift.byLocation);
        return {
          shift: shift.shift,
          orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
          totalAmount: rows.reduce((sum, row) => sum + row.totalAmount, 0),
        };
      });
    const total = picked.reduce((sum, row) => sum + row.totalAmount, 0);
    const orders = picked.reduce((sum, row) => sum + row.orderCount, 0);
    const labels: Record<string, string> = { morning: "☀️ صبح ٨–٤", evening: "🌆 مسا ٤–١٢", night: "🌙 ليل ١٢–٨" };
    const where = match.branch ? ` — ${BRANCH_NAMES[match.branch]}` : "";
    const named = match.shift ? ` (${labels[match.shift].replace(/^\S+ /, "")})` : "";
    const span = match.kind === "shifts_yesterday" ? dateLabel(from)
      : `من ${dateLabel(from)} إلى ${dateLabel(to)}`;
    const heading = `🕐 *شفتات ${when}*${named}${where} — ${span}`;
    if (!total && !orders) return `${heading}\n\nما في مبيعات مسجّلة لهاي الفترة.`;
    const lines = [heading, ""];
    for (const row of picked) {
      const pct = total > 0 ? (row.totalAmount / total) * 100 : 0;
      const share = match.shift ? "" : ` (${pct.toFixed(1)}%)`;
      lines.push(`${labels[row.shift]} — ${money(row.totalAmount, currency)}${share} · ${row.orderCount} عملية`);
    }
    // Today's evening shift has not happened yet, so a small figure would read
    // as a bad night unless the cut-off is stated.
    if (match.kind === "shifts_today") {
      lines.push("", `_لحد الساعة ${new Date(at + AMMAN_OFFSET_MINUTES * 60_000).toISOString().slice(11, 16)}_`);
    }
    if (!match.shift) lines.push("", "━━━━━━━━━━━━━", `💰 *الإجمالي*: ${money(total, currency)} من ${orders} عملية`);
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
  if (match.kind === "data_quality") {
    const q = await session.dataQuality();
    if (!q.total) return "🧹 ما لقيت أصناف فعّالة للبيع بالنظام.";
    // Percent of the live catalogue, because 3,000 sounds like a disaster at
    // 4,000 products and like housekeeping at 60,000. Only what is actually
    // broken is listed: a clean line is left out rather than printed as zero.
    const share = (value: number) => `${Math.round(value * 100 / q.total)}%`;
    const line = (icon: string, label: string, value: number, note: string) =>
      value ? `${icon} ${label}: *${value.toLocaleString("en-US")}* (${share(value)}) — ${note}` : null;
    const rows = [
      line("🏷️", "بدون باركود", q.noBarcode, "بتتباع بالإيد، وبتغلط بالكاشير"),
      line("🔢", "بدون رقم داخلي", q.noReference, "صعب تلاقيها بالجرد"),
      line("💸", "بدون سعر تكلفة", q.noCost, "ما بتقدر تحسب ربح عليها"),
      line("🏷️", "بدون سعر بيع", q.noPrice, "بتوقف عند الكاشير"),
      line("⚠️", "مخزون بالسالب", q.negativeStock, "جرد غلط أو بيع بدون إدخال"),
      q.duplicateNames ? `👥 أسماء مكررة: *${q.duplicateNames}* اسم على ${q.duplicateNameProducts} صنف — نفس الدواء بكذا رصيد` : null,
      q.duplicateBarcodes ? `🔁 باركود مكرر: *${q.duplicateBarcodes}* باركود على ${q.duplicateBarcodeProducts} صنف — الكاشير بيلخبط بينهم` : null,
    ].filter(Boolean) as string[];
    const head = `🧹 *فحص الأصناف* — ${q.total.toLocaleString("en-US")} صنف فعّال للبيع`;
    if (!rows.length) return `${head}

✅ ما لقيت نواقص بالبيانات.`;
    const worst = q.worstNames.length
      ? ["", "*أكثر الأسماء تكرارًا:*", ...q.worstNames.map(row => `• ${row.name.slice(0, 40)} ×${row.count}`)]
      : [];
    // Stock at zero is not a fault on its own -- a catalogue keeps items it no
    // longer carries -- so it sits at the end as context, never in the list of
    // things to fix. (Basim, 2026-09-17: counting those as shortages was wrong.)
    return [head, "", ...rows, ...worst, "",
      `ℹ️ ${q.zeroStock.toLocaleString("en-US")} صنف رصيدها صفر (${share(q.zeroStock)}) — مش بالضرورة خطأ.`].join("\n");
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
    ...items.flatMap((item, index) => shortageLines(item, index)),
  ].join("\n");
}
