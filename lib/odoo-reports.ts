/**
 * Periodic sales/inventory reports pulled from the pharmacy's own Odoo system.
 * A short report every day, a fuller one once a week; posted once to the team
 * group and DMed once to the owner. Uses the same deliverNext(send) contract
 * as secretary-jobs/agent-followups so the bridge drains it identically, and
 * reuses the agent_followups table for once-per-window dedup (kind = odoo_daily
 * | odoo_weekly), exactly like the other proactive kinds already stored there.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrateManagementActions } from "./management-actions.ts";
import { openOdooSession, formatAmount, type OdooConfig, type SalesSummary, type LowStockItem } from "./odoo-client.ts";

export type OdooReportConfig = {
  enabled: boolean;
  odoo: OdooConfig;
  ownerNumber: string; // Basim's WhatsApp number, digits only, no @s.whatsapp.net suffix
  groupId: string | null;
  lowStockThreshold?: number; // default 10 units
  currencyLabel?: string; // e.g. "دينار"; omitted if not configured
  dailyHour?: number; // local hour (0-23) the daily report goes out; default 21
  weeklyDay?: number; // 0=Sunday..6=Saturday; default 6 (Saturday)
  weeklyHour?: number; // local hour the weekly report goes out; default 20
  timezoneOffsetMinutes?: number; // default 180 (Amman/Riyadh, UTC+3)
  fetcher?: typeof fetch; // injected in tests; defaults to the global fetch
};

type Kind = "odoo_daily" | "odoo_weekly";
type Planned = { id: string; kind: Kind; targetUser: string; to: string; text: string };

const DAY = 24 * 60 * 60_000;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
const clean = (value: string) => value.replace(new RegExp("[\\x00-\\x1f\\u202a-\\u202e\\u2066-\\u2069]", "g"), " ").slice(0, 4000);

function localParts(at: number, offsetMinutes: number) {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
}
function alreadySent(db: DatabaseSync, kind: Kind, targetUser: string, since: number): boolean {
  return !!db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND sent_at>=? LIMIT 1").get(kind, targetUser, since);
}
function money(value: number, label?: string): string { return label ? `${formatAmount(value)} ${label}` : formatAmount(value); }

function dailyText(sales: SalesSummary, lowStock: LowStockItem[], dateIso: string, currencyLabel?: string): string {
  const lines = [`📊 تقرير المبيعات اليومي - ${dateIso.slice(0, 10)}`,
    `المبيعات: ${money(sales.totalAmount, currencyLabel)} من ${sales.orderCount} عملية بيع`];
  if (lowStock.length) lines.push(`⚠️ ${lowStock.length} صنف قارب على النفاد أو خلص من المخزون`);
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

async function buildReportText(config: OdooReportConfig, kind: Kind, at: number): Promise<string> {
  const session = await openOdooSession(config.odoo, config.fetcher);
  const threshold = config.lowStockThreshold ?? 10;
  if (kind === "odoo_daily") {
    const since = new Date(at - DAY).toISOString();
    const until = new Date(at).toISOString();
    const [sales, lowStock] = await Promise.all([session.salesSummary(since, until), session.lowStock(threshold)]);
    return dailyText(sales, lowStock, until, config.currencyLabel);
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
  if (day === (config.weeklyDay ?? 6) && hour === (config.weeklyHour ?? 20)) kind = "odoo_weekly";
  else if (hour === (config.dailyHour ?? 21)) kind = "odoo_daily";
  if (!kind) return [];
  // Slightly under a day/week so a delayed retry within the same slot is not
  // mistaken for a fresh window, but the real next firing is never blocked.
  const dedupWindow = (kind === "odoo_weekly" ? 7 * DAY : DAY) - 5 * 60_000;
  const targets: Array<{ targetUser: string; to: string }> = [];
  if (config.groupId) targets.push({ targetUser: "group", to: config.groupId });
  if (config.ownerNumber) targets.push({ targetUser: "owner", to: `${config.ownerNumber}@s.whatsapp.net` });
  const pending = targets.filter(target => !alreadySent(db, kind as Kind, target.targetUser, at - dedupWindow));
  if (!pending.length) return [];
  let text: string;
  try { text = await buildReportText(config, kind, at); }
  catch { text = kind === "odoo_daily" ? "📊 تعذر جلب تقرير المبيعات اليومي من نظام الصيدلية الآن." : "📈 تعذر جلب التقرير الأسبوعي من نظام الصيدلية الآن."; }
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
