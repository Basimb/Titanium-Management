/**
 * Live questions about the CLINICS, answered from the clinics' own finance
 * report. Basim, 2026-09-21: "شو بيع العيادات مثلا؟".
 *
 * Every pattern here must name a clinic. A question that does not say عيادة
 * is a pharmacy question and belongs to odoo-questions.ts: the two systems
 * stay apart in the answers exactly as they do everywhere else, and an
 * ambiguous "شو مبيعات اليوم" must keep meaning the pharmacy, as it always
 * has, rather than quietly changing meaning the day the clinics were wired in.
 */
import { openClinicSession, type ClinicConfig, type ClinicFinance } from "./clinic-client.ts";

export type ClinicQuestionKind = "finance_today" | "finance_yesterday" | "finance_week" | "finance_month" | "help";
export type ClinicQuestionMatch = { kind: ClinicQuestionKind };
export type ClinicAnswerConfig = { clinic: ClinicConfig; currencyLabel?: string; timezoneOffsetMinutes?: number; fetcher?: typeof fetch };

const AMMAN = 180;
const DAY = 24 * 60 * 60_000;
// Same normalisation the pharmacy matcher uses, so both read a message the
// same way: no diacritics, one shape per letter, one space between words.
const normalize = (value: string) => value.normalize("NFKC")
  .replace(/[ً-ٰٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
  .replace(/\s+/g, " ").trim().toLowerCase();

const CLINIC_WORDS = ["عياده", "عيادات", "العياده", "العيادات"];
const MONEY_WORDS = ["مبيعات", "بيع", "باعت", "بعنا", "تحصيل", "التحصيل", "دخل", "ايراد", "الايراد", "كم"];
const PERIODS: Array<{ kind: ClinicQuestionKind; words: string[] }> = [
  { kind: "finance_yesterday", words: ["امبارح", "البارحه", "امس"] },
  { kind: "finance_month", words: ["الشهر", "شهر", "هالشهر"] },
  { kind: "finance_week", words: ["الاسبوع", "اسبوع", "هالاسبوع"] },
  { kind: "finance_today", words: ["اليوم", "هاليوم", "النهارده"] },
];

export function matchClinicQuestion(text: string): ClinicQuestionMatch | null {
  const value = normalize(text);
  if (!value || value.length > 200) return null;
  if (!CLINIC_WORDS.some(word => value.includes(word))) return null;
  if (/شو بتعرف|شو بتقدر|مساعده|المساعده/.test(value)) return { kind: "help" };
  if (!MONEY_WORDS.some(word => value.includes(word))) return null;
  // Longest-lived reading first: a message naming a period means that period,
  // and one naming none means today, which is what people mean when they ask
  // in the middle of a working day.
  for (const period of PERIODS) if (period.words.some(word => value.includes(word))) return { kind: period.kind };
  return { kind: "finance_today" };
}

const HELP = [
  "🏥 *أسئلة العيادات:*",
  "",
  "• «شو بيع العيادات اليوم»",
  "• «تحصيل العيادات امبارح»",
  "• «مبيعات العيادات هالشهر»",
  "",
  "كل رقم بيجي من نظام العيادات مباشرة.",
].join("\n");

const money = (value: number, label?: string) => {
  const text = value.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return label ? `${text} ${label}` : text;
};
const clean = (value: string, max = 60) => value.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, " ").trim().slice(0, max);
const localDate = (at: number, offset: number) => new Date(at + offset * 60_000).toISOString().slice(0, 10);
function startOfLocalDay(at: number, offset: number): number {
  const shifted = new Date(at + offset * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset * 60_000;
}
function startOfLocalMonth(at: number, offset: number): number {
  const shifted = new Date(at + offset * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offset * 60_000;
}

export function clinicAnswerText(report: ClinicFinance, title: string, currencyLabel?: string): string {
  const lines = [`🏥 *${title}*`, report.from === report.until ? `📅 ${report.from}` : `📅 من ${report.from} إلى ${report.until}`, "",
    `💰 التحصيل: *${money(report.net, currencyLabel)}*`];
  if (report.refunded > 0) lines.push(`↩️ مسترجع: ${money(report.refunded, currencyLabel)}`);
  lines.push(`🧾 المفوتر: ${money(report.invoiced, currencyLabel)} — نسبة التحصيل ${report.collectionRate}%`);
  if (report.outstanding > 0) lines.push(`⏳ المستحقات: *${money(report.outstanding, currencyLabel)}*`);
  const doctors = report.byCashier.filter(share => share.total !== 0).slice(0, 8);
  if (doctors.length) {
    lines.push("", "👨‍⚕️ *حسب الطبيب*");
    // Name and amount on their own lines: an Arabic name and an English-digit
    // amount share a line badly once WhatsApp applies its own bidi rules.
    for (const doctor of doctors) lines.push(clean(doctor.name), `${money(doctor.total, currencyLabel)}${doctor.count ? ` — ${doctor.count} فاتورة` : ""}`, "");
  }
  const top = report.byService.filter(share => share.total !== 0)[0];
  if (top) lines.push("🔝 أعلى خدمة", clean(top.name), money(top.total, currencyLabel));
  return lines.join("\n");
}

export async function answerClinicQuestion(match: ClinicQuestionMatch, config: ClinicAnswerConfig, at: number): Promise<string> {
  if (match.kind === "help") return HELP;
  const offset = config.timezoneOffsetMinutes ?? AMMAN;
  const today = startOfLocalDay(at, offset);
  const range = match.kind === "finance_yesterday" ? { from: today - DAY, until: today - DAY, title: "مبيعات العيادات امبارح" }
    : match.kind === "finance_week" ? { from: today - 6 * DAY, until: today, title: "مبيعات العيادات آخر ٧ أيام" }
    : match.kind === "finance_month" ? { from: startOfLocalMonth(at, offset), until: today, title: "مبيعات العيادات من أول الشهر" }
    : { from: today, until: today, title: "مبيعات العيادات اليوم" };
  const session = await openClinicSession(config.clinic, config.fetcher);
  const report = await session.finance(localDate(range.from, offset), localDate(range.until, offset));
  return clinicAnswerText(report, range.title, config.currencyLabel);
}
