/**
 * Periodic sales/inventory/purchasing reports pulled from the pharmacy's own
 * Odoo system: a per-branch sales breakdown every day, a fuller sales+stock
 * report once a week, and a month-to-date purchases-vs-returns report once a
 * week -- the first two posted to the team group and DMed once to the owner,
 * the last group-only. Uses the same deliverNext(send) contract as
 * secretary-jobs/agent-followups so the bridge drains it identically, and
 * reuses the agent_followups table for once-per-window dedup (kind =
 * odoo_daily | odoo_weekly | odoo_purchases_weekly), exactly like the other
 * proactive kinds already stored there.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrateManagementActions } from "./management-actions.ts";
import { openOdooSession, formatAmount, paymentSplitLine, DEFAULT_BRANCH_NAMES, type OdooConfig, type SalesSummary, type InvoiceSales, type ShortageItem, type BranchShortages, type BranchDaySales, type ProductMargin, type UnderListSale, type PurchaseSummary } from "./odoo-client.ts";
import { recordPriceIssues } from "./price-issues.ts";
import { cycleCountMessages, recordListed } from "./cycle-count.ts";
import { branchShortageMessages, packLabel, NO_SHORTAGES } from "./odoo-shortage-text.ts";

// 2026-09-12, Basim: "بدي هذا التقرير كل يوم الساعه 12:01 صباحا يروح للجروب
// بدون موافقتي ويكون تاريخ اليوم اللي قبله" -- the daily report is this exact
// per-branch breakdown (colored, ranked by amount, with each branch's % of
// the day's total), for the full day that just ended, sent straight to the
// group with no confirmation step -- same no-approval delivery this job
// already used for the old total-only daily text, just a different body.
const BRANCH_COLORS = ["🟢", "🔵", "🟡", "🔴", "🟣", "🟠"];

export type OdooReportConfig = {
  enabled: boolean;
  odoo: OdooConfig;
  ownerNumber: string; // Basim's WhatsApp number, digits only, no @s.whatsapp.net suffix
  groupId: string | null;
  currencyLabel?: string; // e.g. "دينار"; omitted if not configured
  branchNames?: Record<string, string>; // Odoo location code -> Arabic branch name, merged over DEFAULT_BRANCH_NAMES
  dailyHour?: number; // local hour (0-23) the daily report goes out; default 0
  // Basim, 2026-09-23: "تقرير مبيعات الصيدليه ما عم يوصل بموعدو... خليه الساعه
  // 12:15 صباحا... بيكونو اقفلو". Until then the schedule knew only the hour,
  // so "midnight" meant any drain inside 00:00-00:59 and the report drifted.
  // With a minute set, the slot opens at that minute and stays open for the
  // rest of the hour -- a bridge that was down at 00:15 still sends at 00:20,
  // because a late report is worth more than none.
  dailyMinute?: number; // local minute (0-59) the daily report may first go out; default 0
  weeklyDay?: number; // 0=Sunday..6=Saturday; default 6 (Saturday) -- shared by both weekly reports below
  weeklyHour?: number; // local hour the weekly sales report goes out; default 20
  // 2026-09-12, Basim: "بدي تجهزلي تقرير مشتريات... ومرتجعات... وتنشرو للجروب
  // كل اسبوع كل يوم سبت" -- a second, separate weekly report (purchases from
  // vendors net of vendor returns, month-to-date), same Saturday, its own hour
  // so it never collides with the sales weekly report above; group only, no
  // owner DM (he asked only for the group).
  purchasesWeeklyHour?: number; // local hour the weekly purchases report goes out; default 19
  // Basim, 2026-09-20: "تقرير النواقص مره باليوم الساعه 9 الصبح" -- and, once
  // he saw it, "كل رساله لحال" per branch. One message per branch, every
  // morning, group only.
  shortagesHour?: number; // local hour the daily shortages report goes out; default 9
  // Basim, 2026-10-02: items sold at a loss or near it, every morning --
  // "على الجروب", "10:00 الصبح". Nothing is sent on a day with none.
  marginHour?: number; // local hour the profit-problems list goes out; default 10
  // Basim, 2026-10-03: a small shelf check per branch every night -- "الجروب",
  // "الليل 10". See lib/cycle-count.ts.
  cycleCountHour?: number; // local hour the nightly count list goes out; default 22
  cycleCountMinute?: number; // local minute it may first go out; default 30 (Basim: "خليها ١٠ ونص")
  timezoneOffsetMinutes?: number; // default 180 (Amman/Riyadh, UTC+3)
  // Basim (2026-09-17): "مبيعات يومي بالفرع كل يوم ١٢ منتصف الليل الجروب بس
  // والغي الثاني لغاية ما اقولك" -- who each report goes to, and whether it
  // goes out at all, is his call and changes; it used to be hard-coded here
  // (daily and weekly to group AND him, purchases to group only). Left unset,
  // every kind keeps exactly that old behaviour, so turning one off is a
  // config change and never a code change.
  routing?: Partial<Record<Kind, Partial<ReportRouting>>>;
  fetcher?: typeof fetch; // injected in tests; defaults to the global fetch
};

type Kind = "odoo_daily" | "odoo_weekly" | "odoo_purchases_weekly" | "odoo_shortages" | "odoo_margin" | "odoo_cycle_count";
export type ReportRouting = { enabled: boolean; group: boolean; owner: boolean };
// Basim, 2026-09-17: "مبيعات يومي بالفرع كل يوم ١٢ منتصف الليل الجروب بس
// والغي الثاني لغاية ما اقولك" -- daily sales per branch, midnight, group only;
// both weeklies off until he says otherwise. These are the defaults rather than
// a setting he has to write down, because the only settings file the bridge
// reads holds secrets and is edited by hand on the server. `routing` still
// overrides any of them, so turning a report back on stays a config change.
const DEFAULT_ROUTING: Record<Kind, ReportRouting> = {
  odoo_daily: { enabled: true, group: true, owner: false },
  odoo_weekly: { enabled: false, group: false, owner: false },
  odoo_purchases_weekly: { enabled: false, group: false, owner: false },
  // Basim, 2026-09-29: "وقف ارسال النواقص على الجروب خلاص ... ما احنا محتاجين
  // نرسل نواقص على الجروب". Off by default; the report and its per-branch
  // formatting stay intact, so turning it back on is this one line.
  odoo_shortages: { enabled: false, group: false, owner: false },
  odoo_margin: { enabled: true, group: true, owner: false },
  odoo_cycle_count: { enabled: true, group: true, owner: false },
};
type CountItems = { locationId: number; productIds: number[] };
type Planned = { id: string; kind: Kind; targetUser: string; entityId: string | null; to: string; text: string; priceIssues?: { day: string; items: string }; countItems?: CountItems };

const DAY = 24 * 60 * 60_000;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
// Strip control/bidi-override characters but keep \n (0x0A) -- these report
// bodies are built as multi-line templates (lines.join("\n")); stripping the
// newline too, as an earlier version of this did, silently flattened every
// report into one unreadable line once it reached WhatsApp.
const clean = (value: string) => value.replace(new RegExp("[\\x00-\\x09\\x0b-\\x1f\\u202a-\\u202e\\u2066-\\u2069]", "g"), " ").slice(0, 4000);

function localParts(at: number, offsetMinutes: number) {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), day: shifted.getUTCDay() };
}
/** A minute outside 0-59, or no minute at all, means "any time this hour". */
const minuteReached = (minute: number, configured?: number) =>
  !Number.isInteger(configured) || configured! < 0 || configured! > 59 || minute >= configured!;
// Basim (2026-09-16), seeing the daily figures: "هذه المبيعات مش يومي ياخي".
// The daily report used to read a ROLLING 24 hours ending at the moment it
// was sent, while labelling itself with yesterday's date. At the default
// midnight slot those coincide, so it was right by accident; at any other
// hour it silently moved the evening's sales into the next day's report --
// and he wants to receive this in the morning, not at midnight. The window
// is now the previous COMPLETE local day, whatever hour the report goes out.
function startOfLocalDay(at: number, offsetMinutes: number): number {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
}
function startOfLocalMonth(at: number, offsetMinutes: number): number {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMinutes * 60_000;
}
// The plain calendar date (YYYY-MM-DD) at `at`, in the configured local
// timezone -- NOT `new Date(at).toISOString().slice(0,10)`, which reads the
// UTC date and is off by one whenever the local day has already turned over
// but UTC hasn't (or vice versa), exactly the case around local midnight at
// a +3 offset. Used both for report date labels and for the plain-date
// (non-datetime) invoice_date filter in the purchases report.
function localDateLabel(at: number, offsetMinutes: number): string {
  return new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10);
}
// entityId is the branch a message covers, so four branch messages in one
// morning are four separate rows and none of them dedups the other three;
// NULL for the reports that are one message.
function alreadySent(db: DatabaseSync, kind: Kind, targetUser: string, entityId: string | null, since: number): boolean {
  return !!(entityId === null
    ? db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND entity_id IS NULL AND sent_at>=? LIMIT 1").get(kind, targetUser, since)
    : db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND entity_id=? AND sent_at>=? LIMIT 1").get(kind, targetUser, entityId, since));
}
function money(value: number, label?: string): string { return label ? `${formatAmount(value)} ${label}` : formatAmount(value); }

function branchLabel(location: string, names: Record<string, string>): string {
  const code = location.split("/")[0]?.trim().toUpperCase();
  return (code && names[code]) || location;
}

// Basim, 2026-09-29, approving the example: each branch's total with its
// number of sales beside it, and under it one line -- cash, card, insurance
// side by side, ذمم only when there were any.
function dailyText(byLocation: BranchDaySales[], dateLabel: string, currencyLabel: string | undefined, branchNames: Record<string, string> | undefined): string {
  const names = { ...DEFAULT_BRANCH_NAMES, ...branchNames };
  const total = byLocation.reduce((sum, row) => sum + row.totalAmount, 0);
  const orders = byLocation.reduce((sum, row) => sum + row.orderCount, 0);
  const ranked = [...byLocation].sort((a, b) => b.totalAmount - a.totalAmount);
  const lines = [`📊 *تقرير المبيعات اليومي — ${dateLabel}*`, ""];
  ranked.forEach((row, index) => {
    const color = BRANCH_COLORS[index % BRANCH_COLORS.length];
    lines.push(`${color} *${clean(branchLabel(row.location, names))} — ${money(row.totalAmount, currencyLabel)} (${row.orderCount} حركة)*`);
    const split = paymentSplitLine(row.payments);
    if (split) lines.push(split);
    lines.push("");
  });
  if (!ranked.length) lines.push("لا توجد مبيعات مسجّلة لهذا اليوم.", "");
  lines.push("━━━━━━━━━━━━━", `💰 *الإجمالي: ${money(total, currencyLabel)} — ${orders} حركة*`);
  return clean(lines.join("\n"));
}

// Basim, 2026-10-02, on the morning profit job: "ما بدي تقرير الصبح بدي هذول
// الاصناف ... ودي لي وين مشاكل الربح". Not a margin report -- only the items
// that need fixing: sold yesterday at a loss or close to it, which means the
// sale price is stale or the cost moved on the last purchase. A day with none
// sends nothing at all.
const NEAR_LOSS = 5; // %
const pctOf = (sales: number, cost: number) => sales > 0 ? ((sales - cost) / sales) * 100 : 0;
const MAX_LISTED = 30;

// Wording is Basim's own, 2026-10-02: a morning greeting to the team, the
// list, then Dr. Shadi -- whose job pricing is -- asked whether he wants it as
// a task (a private "1" is already the secretary's "add a task" shortcut) or
// will fix it himself, and reminded that a reply in the group needs the word
// سكرتير, the only thing that makes the secretary answer there.
const PROFIT_CLEAN = "✅ ما في مشاكل ربح امبارح";
const LIST_CLEAN = "✅ وكل الأصناف انباعت بسعر بطاقتها";
const MAX_UNDER_LISTED = 15;
const price3 = (value: number) => value.toFixed(3);

function marginProblems(products: ProductMargin[]): ProductMargin[] {
  // A line with no booked cost is unknown, not free: it is left out rather
  // than reported as a problem it may not be.
  return products.filter(row => row.sales > 0 && row.cost > 0 && pctOf(row.sales, row.cost) < NEAR_LOSS)
    .sort((a, b) => pctOf(a.sales, a.cost) - pctOf(b.sales, b.cost));
}

// One morning message: the profit problems (Dr. Shadi's) and the lines rung
// up below the item card (the cashiers'). A clean day still says so -- Basim,
// 2026-10-03: "✅ ما في مشاكل ربح امبارح" -- so the group knows it checked.
function morningPriceText(products: ProductMargin[], underList: UnderListSale[], dateLabel: string): { text: string; items: string | null } {
  const losing = marginProblems(products);
  if (!losing.length && !underList.length) return { text: `${PROFIT_CLEAN}\n${LIST_CLEAN}`, items: null };
  const lines = [
    "صباح الخير فريق عمل تيتانيوم الجبّار ☀️",
    "بعرض عليكم مشاكل البيع والنِّسب القليلة عشان تتأكدوا من الأسعار والكلفة، يعطيكم العافية.",
    "",
  ];
  if (losing.length) {
    const noun = losing.length === 1 ? "صنف" : losing.length <= 10 ? "أصناف" : "صنف";
    lines.push(`⚠️ *مبيعات ${dateLabel} — ${losing.length} ${noun}:*`, "");
    losing.slice(0, MAX_LISTED).forEach((row, index) => {
      const margin = pctOf(row.sales, row.cost);
      // Basim: "حط له الوان ... راد وورا خضره" -- worst at the top in red,
      // easing down to green for the ones only just under the line.
      const color = margin < 0 ? "🔴" : margin < 2 ? "🟠" : margin < 4 ? "🟡" : "🟢";
      lines.push(`${color} *${index + 1}.* ${clean(row.name)}`,
        `بيع ${formatAmount(row.sales)} · كلفة ${formatAmount(row.cost)} · ${margin < 0 ? `خسارة ${Math.abs(margin).toFixed(1)}%` : `ربح ${margin.toFixed(1)}%`}`, "");
    });
    if (losing.length > MAX_LISTED) lines.push(`و${losing.length - MAX_LISTED} صنف ثاني.`, "");
  } else lines.push(PROFIT_CLEAN, "");
  if (underList.length) {
    lines.push(`🏷️ *انباعت بأقل من سعر البطاقة — ${underList.length} بند:*`, "");
    underList.slice(0, MAX_UNDER_LISTED).forEach((row, index) => {
      // Name, prices and who/where each on their own line, for the same bidi
      // reason as above.
      lines.push(`*${index + 1}.* ${clean(row.name)}`,
        `البطاقة ${price3(row.listPrice)} · انباع ${price3(row.soldPrice)} × ${row.qty}`,
        `${clean(row.employee)} · ${clean(row.order)}`, "");
    });
    if (underList.length > MAX_UNDER_LISTED) lines.push(`و${underList.length - MAX_UNDER_LISTED} بند ثاني.`, "");
  } else lines.push(LIST_CLEAN, "");
  if (losing.length) lines.push(
    "━━━━━━━━━━━━━",
    "د. شادي، هاي مسؤوليتك 👆",
    "بتحب أحطلك ياها مهمة، ولا رح تعالجهم فوراً؟",
    "إذا بدك ياها مهمة: ابعتلي على الخاص رقم *1* واكتب المهمة عن تعديل الأسعار، وأنا بجهزلك المهمة كاملة. شكراً إلك 🙏",
    "",
    "_وإذا بدك ترد عليّ بالجروب، الرجاء تذكر كلمة *سكرتير* بالرسالة عشان أفهم إنها موجهة إلي._",
  );
  const items = losing.length ? losing.map((row, index) => {
    const margin = pctOf(row.sales, row.cost);
    // Two lines, as in the group message: an English name and Arabic figures
    // on one line are reordered by WhatsApp's bidi rules into nonsense.
    return `${index + 1}. ${clean(row.name)}\nبيع ${formatAmount(row.sales)} · كلفة ${formatAmount(row.cost)} · ${margin < 0 ? `خسارة ${Math.abs(margin).toFixed(1)}%` : `ربح ${margin.toFixed(1)}%`}`;
  }).join("\n") : null;
  return { text: clean(lines.join("\n").trim()), items };
}

function weeklyText(sales: SalesSummary, invoiced: InvoiceSales, shortages: ShortageItem[],
  activeProducts: number, sinceLabel: string, untilLabel: string, currencyLabel?: string): string {
  // The basket is sales over SALES, not over sales plus refunds -- counting a
  // refund as an operation pushes this below the truth.
  const average = sales.orderCount ? (sales.totalAmount + sales.refundAmount) / sales.orderCount : 0;
  const lines = [
    `📈 التقرير الأسبوعي - من ${sinceLabel} إلى ${untilLabel}`,
    `إجمالي المبيعات: ${money(sales.totalAmount, currencyLabel)} من ${sales.orderCount} عملية بيع`,
  ];
  if (sales.refundCount) lines.push(`↩️ مرتجعات: ${money(sales.refundAmount, currencyLabel)} من ${sales.refundCount} عملية (مطروحة من الإجمالي)`);
  // Sales that never touch the till. Silent when there are none, so a pharmacy
  // that only rings things up sees exactly what it saw before.
  if (invoiced.invoiceCount) lines.push(`🧾 مبيعات بفواتير: ${money(invoiced.totalAmount, currencyLabel)} من ${invoiced.invoiceCount} فاتورة`);
  lines.push(`متوسط الفاتورة: ${money(average, currencyLabel)}`, `إجمالي عدد الأصناف النشطة: ${activeProducts}`);
  if (shortages.length) {
    lines.push("رح تخلص خلال أسبوع:");
    for (const [index, item] of shortages.entries()) {
      // Name and measurement on separate lines, for the reason set out beside
      // shortageLines in odoo-questions.ts: an English name and an Arabic
      // measurement on one line are laid out by WhatsApp's own bidi rules and
      // come out unreadable.
      lines.push(`${index + 1}. ${clean(item.name)}`, `المتوفر: ${packLabel(item.packs)} علبة`, "");
    }
  } else lines.push("ما في صنف متحرّك رح يخلص خلال أسبوع.");
  return clean(lines.join("\n"));
}


function purchasesText(summary: PurchaseSummary, sinceDate: string, untilDate: string, currencyLabel?: string): string {
  const net = summary.purchaseAmount - summary.returnAmount;
  const lines = [
    "🧾 *تقرير المشتريات (من أول الشهر)*",
    `📅 من ${sinceDate} إلى ${untilDate}`,
    "",
    `🛒 المشتريات: ${money(summary.purchaseAmount, currencyLabel)} من ${summary.purchaseCount} فاتورة مورد`,
    `↩️ مرتجعات للموردين: ${money(summary.returnAmount, currencyLabel)} من ${summary.returnCount} إشعار`,
    "━━━━━━━━━━━━━",
    `💰 *الصافي*: ${money(net, currencyLabel)}`,
  ];
  return clean(lines.join("\n"));
}

// One report can be several messages: the shortages report sends one per
// branch (and splits a long branch), every other kind sends exactly one.
// entityId is what keeps them apart in the dedup table.
// priceIssues rides along with the profit-problems list so that, once sent,
// the secretary can attach it to a price task (see price-issues.ts).
type ReportMessage = { entityId: string | null; text: string; priceIssues?: { day: string; items: string }; countItems?: CountItems };

// The bridge drains its queues once a SECOND. A one-message report is asked
// for once and then skipped by the cheap dedup check above, but the per-branch
// one has no single id to check, so without this it would rescan the
// pharmacy's whole catalogue every second for the length of its hour. Built
// once per local day per kind and reused until the day turns over -- held
// against the database this job writes to, so two jobs never read each other's
// report.
const messageCache = new WeakMap<DatabaseSync, { key: string; messages: ReportMessage[] }>();

async function buildReportMessages(db: DatabaseSync, config: OdooReportConfig, kind: Kind, at: number): Promise<ReportMessage[]> {
  const key = `${kind}|${localDateLabel(at, config.timezoneOffsetMinutes ?? 180)}`;
  const cached = messageCache.get(db);
  if (cached && cached.key === key) return cached.messages;
  let messages: ReportMessage[];
  try { messages = await buildReportMessagesFresh(db, config, kind, at); }
  catch {
    // The failure is cached with everything else: the message below is about
    // to be sent and deduped for the day, so retrying the scan every second
    // for the rest of the hour would only hammer the pharmacy's system.
    messages = [{ entityId: null, text: kind === "odoo_daily" ? "📊 تعذر جلب تقرير المبيعات اليومي من نظام الصيدلية الآن."
      : kind === "odoo_purchases_weekly" ? "🧾 تعذر جلب تقرير المشتريات من نظام الصيدلية الآن."
      : kind === "odoo_shortages" ? "📦 تعذر جلب تقرير النواقص من نظام الصيدلية الآن."
      : kind === "odoo_margin" ? "⚠️ تعذر جلب مشاكل الربح من نظام الصيدلية الآن."
      : kind === "odoo_cycle_count" ? "🔎 تعذر جلب قائمة جرد الليلة من نظام الصيدلية الآن."
      : "📈 تعذر جلب التقرير الأسبوعي من نظام الصيدلية الآن." }];
  }
  messageCache.set(db, { key, messages });
  return messages;
}

async function buildReportMessagesFresh(db: DatabaseSync, config: OdooReportConfig, kind: Kind, at: number): Promise<ReportMessage[]> {
  const session = await openOdooSession(config.odoo, config.fetcher);
  if (kind === "odoo_cycle_count") {
    // Nothing to check is nothing to send: no "all clear" for a list the
    // staff did not ask for.
    return cycleCountMessages(db, await session.branchCountSuspects({ at }), { ...DEFAULT_BRANCH_NAMES, ...config.branchNames }, at);
  }
  if (kind === "odoo_shortages") {
    const names = { ...DEFAULT_BRANCH_NAMES, ...config.branchNames };
    const branches = await session.branchShortages({ maxDaysLeft: 7, at });
    if (!branches.length) return [{ entityId: null, text: NO_SHORTAGES }];
    return branchShortageMessages(branches, names);
  }
  if (kind === "odoo_margin") {
    const offset = config.timezoneOffsetMinutes ?? 180;
    const dayStart = startOfLocalDay(at, offset) - DAY;
    const since = new Date(dayStart).toISOString(), until = new Date(dayStart + DAY).toISOString();
    const [products, underList] = await Promise.all([session.productMargins(since, until), session.underListSales(since, until)]);
    const day = localDateLabel(dayStart, offset);
    const morning = morningPriceText(products, underList, day);
    return [{ entityId: null, text: morning.text, ...(morning.items ? { priceIssues: { day, items: morning.items } } : {}) }];
  }
  return [{ entityId: null, text: await buildReportBody(config, session, kind, at) }];
}

async function buildReportBody(config: OdooReportConfig, session: Awaited<ReturnType<typeof openOdooSession>>, kind: Kind, at: number): Promise<string> {
  if (kind === "odoo_daily") {
    const offset = config.timezoneOffsetMinutes ?? 180;
    const dayStart = startOfLocalDay(at, offset) - DAY;
    const since = new Date(dayStart).toISOString();
    const until = new Date(dayStart + DAY).toISOString();
    const byLocation = await session.branchDaySales(since, until);
    return dailyText(byLocation, localDateLabel(dayStart, offset), config.currencyLabel, config.branchNames);
  }
  if (kind === "odoo_purchases_weekly") {
    const offset = config.timezoneOffsetMinutes ?? 180;
    const sinceDate = localDateLabel(startOfLocalMonth(at, offset), offset);
    const untilDate = localDateLabel(at, offset);
    const summary = await session.purchaseSummary(sinceDate, untilDate);
    return purchasesText(summary, sinceDate, untilDate, config.currencyLabel);
  }
  // Whole local days, not a rolling 168 hours. Basim on the daily report:
  // "هذه المبيعات مش يومي ياخي" -- the weekly had exactly the same fault, and
  // a week that starts mid-afternoon is a week nobody can check against a till.
  const offset = config.timezoneOffsetMinutes ?? 180;
  const untilMs = startOfLocalDay(at, offset);
  const sinceMs = untilMs - 7 * DAY;
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  const [sales, invoiced, shortages, activeProducts] = await Promise.all([
    session.salesSummary(since, until), session.invoiceSales(since, until),
    session.shortages({ maxDaysLeft: 7, limit: 15, at }), session.activeProductCount(),
  ]);
  return weeklyText(sales, invoiced, shortages, activeProducts,
    localDateLabel(sinceMs, offset), localDateLabel(untilMs - DAY, offset), config.currencyLabel);
}

async function planOdooReports(db: DatabaseSync, config: OdooReportConfig, at: number): Promise<Planned[]> {
  migrateManagementActions(db);
  if (!config.enabled) return [];
  const offset = config.timezoneOffsetMinutes ?? 180;
  const { hour, minute, day } = localParts(at, offset);
  const routingFor = (candidate: Kind): ReportRouting => ({ ...DEFAULT_ROUTING[candidate], ...(config.routing?.[candidate] ?? {}) });
  let kind: Kind | null = null;
  if (day === (config.weeklyDay ?? 6) && hour === (config.purchasesWeeklyHour ?? 19)) kind = "odoo_purchases_weekly";
  else if (day === (config.weeklyDay ?? 6) && hour === (config.weeklyHour ?? 20)) kind = "odoo_weekly";
  // Daily sales first: if the two are configured to the same hour, the one
  // that was asked for by name wins the slot rather than the newer default.
  else if (hour === (config.dailyHour ?? 0) && minuteReached(minute, config.dailyMinute)) kind = "odoo_daily";
  else if (hour === (config.shortagesHour ?? 9)) kind = "odoo_shortages";
  else if (hour === (config.marginHour ?? 10)) kind = "odoo_margin";
  else if (hour === (config.cycleCountHour ?? 22) && minuteReached(minute, config.cycleCountMinute ?? 30)) kind = "odoo_cycle_count";
  if (!kind) return [];
  const routing = routingFor(kind);
  // A switched-off report costs nothing: no targets, and -- just as important
  // -- buildReportText below is never reached, so a disabled report never
  // touches the pharmacy's system at all.
  if (!routing.enabled) return [];
  // Keyed to the report's own local day, not to a rolling window. A rolling
  // ~24h meant a manual test send swallowed the next scheduled report --
  // which is exactly what happened to Basim on 2026-09-16.
  const daily = kind === "odoo_daily" || kind === "odoo_shortages" || kind === "odoo_margin" || kind === "odoo_cycle_count";
  const dedupSince = daily ? startOfLocalDay(at, offset) : at - (7 * DAY - 5 * 60_000);
  const targets: Array<{ targetUser: string; to: string }> = [];
  if (routing.group && config.groupId) targets.push({ targetUser: "group", to: config.groupId });
  if (routing.owner && config.ownerNumber) targets.push({ targetUser: "owner", to: `${config.ownerNumber}@s.whatsapp.net` });
  if (!targets.length) return [];
  // Cheap check first, for the one-message kinds: if every target already has
  // today's report, the pharmacy's system is never touched at all. The
  // shortages report has no single id to check here, so it goes on to the
  // per-message check below.
  if (kind !== "odoo_shortages" && kind !== "odoo_cycle_count" && targets.every(target => alreadySent(db, kind as Kind, target.targetUser, null, dedupSince))) return [];
  const messages = await buildReportMessages(db, config, kind, at);
  const planned: Planned[] = [];
  for (const target of targets) {
    for (const message of messages) {
      if (alreadySent(db, kind as Kind, target.targetUser, message.entityId, dedupSince)) continue;
      planned.push({ id: randomBytes(8).toString("hex"), kind: kind as Kind, targetUser: target.targetUser,
        entityId: message.entityId, to: target.to, text: message.text, ...(message.priceIssues ? { priceIssues: message.priceIssues } : {}),
        ...(message.countItems ? { countItems: message.countItems } : {}) });
    }
  }
  return planned;
}

export function createOdooReportJobs({ db, config, now = Date.now }: { db: DatabaseSync; config: OdooReportConfig | (() => OdooReportConfig); now?: () => number }) {
  let running = false;
  const current = () => typeof config === "function" ? config() : config;
  return {
    async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal }) => Promise<unknown>) {
      if (running) return { status: "idle" as const };
      running = true;
      try {
        const at = now();
        const plan = (await planOdooReports(db, current(), at))[0];
        if (!plan) return { status: "idle" as const };
        // Record first so a crash mid-send never causes a duplicate report.
        db.prepare("INSERT OR REPLACE INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES (?,?,?,?,?,'sending')").run(plan.id, plan.kind, plan.targetUser, plan.entityId, at);
        const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([send({ to: plan.to, text: plan.text, messageId: newMessageId(), signal: controller.signal }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("delivery_uncertain")); }, 15_000); })]);
          db.prepare("UPDATE agent_followups SET response='sent' WHERE id=?").run(plan.id);
          if (plan.priceIssues) recordPriceIssues(db, plan.priceIssues.day, plan.priceIssues.items, at);
          if (plan.countItems) recordListed(db, plan.countItems.locationId, plan.countItems.productIds, at);
          return { status: "sent" as const };
        } catch { db.prepare("UPDATE agent_followups SET response='failed' WHERE id=?").run(plan.id); return { status: "failed" as const }; }
        finally { clearTimeout(timeout); }
      } finally { running = false; }
    },
  };
}
