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
import { openOdooSession, formatAmount, type OdooConfig, type SalesSummary, type LowStockItem, type LocationSales, type PurchaseSummary } from "./odoo-client.ts";

// 2026-09-12, Basim: "بدي هذا التقرير كل يوم الساعه 12:01 صباحا يروح للجروب
// بدون موافقتي ويكون تاريخ اليوم اللي قبله" -- the daily report is this exact
// per-branch breakdown (colored, ranked by amount, with each branch's % of
// the day's total), for the full day that just ended, sent straight to the
// group with no confirmation step -- same no-approval delivery this job
// already used for the old total-only daily text, just a different body.
const BRANCH_COLORS = ["🟢", "🔵", "🟡", "🔴", "🟣", "🟠"];
// Friendly Arabic names for the Odoo warehouse location codes (the part of
// "CODE/Stock" before the slash); config.branchNames can add to or override
// this. An unmapped code falls back to its raw Odoo location name.
const DEFAULT_BRANCH_NAMES: Record<string, string> = { NAOOR: "الناعور", SAFOT: "صافوط", DABOQ: "دابوق", JUMRK: "الجمرك" };

export type OdooReportConfig = {
  enabled: boolean;
  odoo: OdooConfig;
  ownerNumber: string; // Basim's WhatsApp number, digits only, no @s.whatsapp.net suffix
  groupId: string | null;
  lowStockThreshold?: number; // default 10 units
  currencyLabel?: string; // e.g. "دينار"; omitted if not configured
  branchNames?: Record<string, string>; // Odoo location code -> Arabic branch name, merged over DEFAULT_BRANCH_NAMES
  dailyHour?: number; // local hour (0-23) the daily report goes out; default 0 (12:01am slot)
  weeklyDay?: number; // 0=Sunday..6=Saturday; default 6 (Saturday) -- shared by both weekly reports below
  weeklyHour?: number; // local hour the weekly sales report goes out; default 20
  // 2026-09-12, Basim: "بدي تجهزلي تقرير مشتريات... ومرتجعات... وتنشرو للجروب
  // كل اسبوع كل يوم سبت" -- a second, separate weekly report (purchases from
  // vendors net of vendor returns, month-to-date), same Saturday, its own hour
  // so it never collides with the sales weekly report above; group only, no
  // owner DM (he asked only for the group).
  purchasesWeeklyHour?: number; // local hour the weekly purchases report goes out; default 19
  timezoneOffsetMinutes?: number; // default 180 (Amman/Riyadh, UTC+3)
  fetcher?: typeof fetch; // injected in tests; defaults to the global fetch
};

type Kind = "odoo_daily" | "odoo_weekly" | "odoo_purchases_weekly";
type Planned = { id: string; kind: Kind; targetUser: string; to: string; text: string };

const DAY = 24 * 60 * 60_000;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
// Strip control/bidi-override characters but keep \n (0x0A) -- these report
// bodies are built as multi-line templates (lines.join("\n")); stripping the
// newline too, as an earlier version of this did, silently flattened every
// report into one unreadable line once it reached WhatsApp.
const clean = (value: string) => value.replace(new RegExp("[\\x00-\\x09\\x0b-\\x1f\\u202a-\\u202e\\u2066-\\u2069]", "g"), " ").slice(0, 4000);

function localParts(at: number, offsetMinutes: number) {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
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
function alreadySent(db: DatabaseSync, kind: Kind, targetUser: string, since: number): boolean {
  return !!db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND sent_at>=? LIMIT 1").get(kind, targetUser, since);
}
function money(value: number, label?: string): string { return label ? `${formatAmount(value)} ${label}` : formatAmount(value); }

function branchLabel(location: string, names: Record<string, string>): string {
  const code = location.split("/")[0]?.trim().toUpperCase();
  return (code && names[code]) || location;
}

function dailyText(byLocation: LocationSales[], dateLabel: string, currencyLabel: string | undefined, branchNames: Record<string, string> | undefined): string {
  const names = { ...DEFAULT_BRANCH_NAMES, ...branchNames };
  const total = byLocation.reduce((sum, row) => sum + row.totalAmount, 0);
  const ranked = [...byLocation].sort((a, b) => b.totalAmount - a.totalAmount);
  const lines = [`📊 *تقرير المبيعات اليومي بالفرع*`, `📅 ${dateLabel}`, ""];
  ranked.forEach((row, index) => {
    const pct = total > 0 ? (row.totalAmount / total) * 100 : 0;
    const color = BRANCH_COLORS[index % BRANCH_COLORS.length];
    lines.push(`${color} *${clean(branchLabel(row.location, names))}* — ${money(row.totalAmount, currencyLabel)} (${pct.toFixed(1)}%)`);
  });
  if (!ranked.length) lines.push("لا توجد مبيعات مسجّلة لهذا اليوم.");
  lines.push("", "━━━━━━━━━━━━━", `💰 *الإجمالي*: ${money(total, currencyLabel)}`);
  return clean(lines.join("\n"));
}

function weeklyText(sales: SalesSummary, lowStock: LowStockItem[], activeProducts: number, sinceIso: string, untilIso: string, currencyLabel?: string): string {
  const average = sales.orderCount ? sales.totalAmount / sales.orderCount : 0;
  const lines = [
    `📈 التقرير الأسبوعي - من ${sinceIso.slice(0, 10)} إلى ${untilIso.slice(0, 10)}`,
    `إجمالي المبيعات: ${money(sales.totalAmount, currencyLabel)} من ${sales.orderCount} عملية بيع`,
    `متوسط الفاتورة: ${money(average, currencyLabel)}`,
    `إجمالي عدد الأصناف النشطة: ${activeProducts}`,
  ];
  if (lowStock.length) {
    lines.push(`الأصناف القاربة على النفاد أو الخالصة (${lowStock.length}):`);
    for (const item of lowStock.slice(0, 15)) lines.push(`• ${clean(item.name)} — الكمية: ${item.qty}`);
    if (lowStock.length > 15) lines.push("…");
  } else lines.push("لا يوجد أصناف قاربت على النفاد.");
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

async function buildReportText(config: OdooReportConfig, kind: Kind, at: number): Promise<string> {
  const session = await openOdooSession(config.odoo, config.fetcher);
  const threshold = config.lowStockThreshold ?? 10;
  if (kind === "odoo_daily") {
    const offset = config.timezoneOffsetMinutes ?? 180;
    const since = new Date(at - DAY).toISOString();
    const until = new Date(at).toISOString();
    const byLocation = await session.salesByLocation(since, until);
    return dailyText(byLocation, localDateLabel(at - DAY, offset), config.currencyLabel, config.branchNames);
  }
  if (kind === "odoo_purchases_weekly") {
    const offset = config.timezoneOffsetMinutes ?? 180;
    const sinceDate = localDateLabel(startOfLocalMonth(at, offset), offset);
    const untilDate = localDateLabel(at, offset);
    const summary = await session.purchaseSummary(sinceDate, untilDate);
    return purchasesText(summary, sinceDate, untilDate, config.currencyLabel);
  }
  const since = new Date(at - 7 * DAY).toISOString();
  const until = new Date(at).toISOString();
  const [sales, lowStock, activeProducts] = await Promise.all([session.salesSummary(since, until), session.lowStock(threshold), session.activeProductCount()]);
  return weeklyText(sales, lowStock, activeProducts, since, until, config.currencyLabel);
}

async function planOdooReports(db: DatabaseSync, config: OdooReportConfig, at: number): Promise<Planned[]> {
  migrateManagementActions(db);
  if (!config.enabled) return [];
  const offset = config.timezoneOffsetMinutes ?? 180;
  const { hour, day } = localParts(at, offset);
  let kind: Kind | null = null;
  if (day === (config.weeklyDay ?? 6) && hour === (config.purchasesWeeklyHour ?? 19)) kind = "odoo_purchases_weekly";
  else if (day === (config.weeklyDay ?? 6) && hour === (config.weeklyHour ?? 20)) kind = "odoo_weekly";
  else if (hour === (config.dailyHour ?? 0)) kind = "odoo_daily";
  if (!kind) return [];
  // Slightly under a day/week so a delayed retry within the same slot is not
  // mistaken for a fresh window, but the real next firing is never blocked.
  const dedupWindow = (kind === "odoo_daily" ? DAY : 7 * DAY) - 5 * 60_000;
  const targets: Array<{ targetUser: string; to: string }> = [];
  if (config.groupId) targets.push({ targetUser: "group", to: config.groupId });
  // Basim only asked for the purchases report to go to the group, not to him privately.
  if (config.ownerNumber && kind !== "odoo_purchases_weekly") targets.push({ targetUser: "owner", to: `${config.ownerNumber}@s.whatsapp.net` });
  const pending = targets.filter(target => !alreadySent(db, kind as Kind, target.targetUser, at - dedupWindow));
  if (!pending.length) return [];
  let text: string;
  try { text = await buildReportText(config, kind, at); }
  catch {
    text = kind === "odoo_daily" ? "📊 تعذر جلب تقرير المبيعات اليومي من نظام الصيدلية الآن."
      : kind === "odoo_purchases_weekly" ? "🧾 تعذر جلب تقرير المشتريات من نظام الصيدلية الآن."
      : "📈 تعذر جلب التقرير الأسبوعي من نظام الصيدلية الآن.";
  }
  return pending.map(target => ({ id: randomBytes(8).toString("hex"), kind: kind as Kind, targetUser: target.targetUser, to: target.to, text }));
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
        db.prepare("INSERT OR REPLACE INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES (?,?,?,NULL,?,'sending')").run(plan.id, plan.kind, plan.targetUser, at);
        const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([send({ to: plan.to, text: plan.text, messageId: newMessageId(), signal: controller.signal }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("delivery_uncertain")); }, 15_000); })]);
          db.prepare("UPDATE agent_followups SET response='sent' WHERE id=?").run(plan.id);
          return { status: "sent" as const };
        } catch { db.prepare("UPDATE agent_followups SET response='failed' WHERE id=?").run(plan.id); return { status: "failed" as const }; }
        finally { clearTimeout(timeout); }
      } finally { running = false; }
    },
  };
}
