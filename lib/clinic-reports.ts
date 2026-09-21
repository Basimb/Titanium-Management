/**
 * The clinics' daily money report, posted to the team group just after the
 * pharmacy's own daily one. Basim, 2026-09-21: "بدي يجي كمان مين اللي باع اي
 * عياده الطب العام ولا انسائيه" -- so it carries the split by doctor, not
 * just a total.
 *
 * A job of its own, with its own queue, its own config and its own dedup
 * rows: "بدون ما نلخبط القصص ببعض". Nothing here can delay, replace or break
 * an Odoo report, and nothing there can stop this one going out.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrateManagementActions } from "./management-actions.ts";
import { openClinicSession, type ClinicConfig, type ClinicFinance } from "./clinic-client.ts";

export type ClinicReportConfig = {
  enabled: boolean;
  clinic: ClinicConfig;
  groupId: string | null;
  ownerNumber?: string;
  toOwner?: boolean; // DM Basim as well as the group; default false (group only)
  currencyLabel?: string;
  dailyHour?: number; // local hour the report goes out; default 0 (the 12:0x slot)
  timezoneOffsetMinutes?: number; // default 180 (Amman, UTC+3)
  maxDoctors?: number; // default 8
  fetcher?: typeof fetch;
};

const KIND = "clinic_daily";
const DAY = 24 * 60 * 60_000;
const newMessageId = () => "3EB0" + randomBytes(18).toString("hex").toUpperCase();
// Keep \n: these bodies are multi-line templates, and stripping the newline
// flattens the whole report into one unreadable line once it reaches WhatsApp.
const clean = (value: string) => value.replace(new RegExp("[\\x00-\\x09\\x0b-\\x1f\\u202a-\\u202e\\u2066-\\u2069]", "g"), " ").slice(0, 3800);
const money = (value: number, label?: string) => {
  const text = value.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return label ? `${text} ${label}` : text;
};
function localParts(at: number, offsetMinutes: number) {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return { hour: shifted.getUTCHours() };
}
function startOfLocalDay(at: number, offsetMinutes: number): number {
  const shifted = new Date(at + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
}
const localDate = (at: number, offsetMinutes: number) => new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10);
function alreadySent(db: DatabaseSync, targetUser: string, since: number): boolean {
  return !!db.prepare("SELECT id FROM agent_followups WHERE kind=? AND target_user=? AND sent_at>=? LIMIT 1").get(KIND, targetUser, since);
}

export function clinicReportText(report: ClinicFinance, dateLabel: string, currencyLabel?: string, maxDoctors = 8): string {
  const lines = ["🏥 *تقرير العيادات اليومي*", `📅 ${dateLabel}`, "",
    `💰 التحصيل: *${money(report.net, currencyLabel)}*`];
  if (report.refunded > 0) lines.push(`↩️ مسترجع: ${money(report.refunded, currencyLabel)} (مطروح من التحصيل)`);
  lines.push(`🧾 المفوتر: ${money(report.invoiced, currencyLabel)} — نسبة التحصيل ${report.collectionRate}%`);
  // Silent when nothing is owed: a zero line every day teaches people to skip
  // the report, and this is the number that matters when it is NOT zero.
  if (report.outstanding > 0) lines.push(`⏳ المستحقات: *${money(report.outstanding, currencyLabel)}*`);
  const doctors = report.byCashier.filter(share => share.total !== 0).slice(0, maxDoctors);
  if (doctors.length) {
    lines.push("", "👨‍⚕️ *حسب الطبيب*");
    // Name and amount on separate lines, for the same reason the shortage
    // report does it: an Arabic name and an English-digit amount on one line
    // are laid out by WhatsApp's own bidi rules and come out scrambled.
    for (const doctor of doctors) {
      lines.push(clean(doctor.name), `${money(doctor.total, currencyLabel)}${doctor.count ? ` — ${doctor.count} فاتورة` : ""}`, "");
    }
  }
  const top = report.byService.filter(share => share.total !== 0)[0];
  if (top) lines.push("🔝 أعلى خدمة", clean(top.name), money(top.total, currencyLabel));
  return clean(lines.join("\n"));
}

type Planned = { id: string; targetUser: string; to: string; text: string };

async function planClinicReport(db: DatabaseSync, config: ClinicReportConfig, at: number): Promise<Planned[]> {
  migrateManagementActions(db);
  if (!config.enabled) return [];
  const offset = config.timezoneOffsetMinutes ?? 180;
  if (localParts(at, offset).hour !== (config.dailyHour ?? 0)) return [];
  const targets: Array<{ targetUser: string; to: string }> = [];
  if (config.groupId) targets.push({ targetUser: "group", to: config.groupId });
  if (config.toOwner && config.ownerNumber) targets.push({ targetUser: "owner", to: `${config.ownerNumber}@s.whatsapp.net` });
  if (!targets.length) return [];
  // Keyed to the report's own local day, so a manual test send never swallows
  // the scheduled one and a restart never sends it twice.
  const dedupSince = startOfLocalDay(at, offset);
  const pending = targets.filter(target => !alreadySent(db, target.targetUser, dedupSince));
  if (!pending.length) return [];
  // The day that just ended, whole -- never a rolling 24 hours, which at any
  // hour but midnight quietly moves an evening's money into the next day.
  const day = localDate(startOfLocalDay(at, offset) - DAY, offset);
  let text: string;
  try {
    const session = await openClinicSession(config.clinic, config.fetcher);
    text = clinicReportText(await session.finance(day, day), day, config.currencyLabel, config.maxDoctors ?? 8);
  } catch { text = "🏥 تعذر جلب تقرير العيادات اليومي الآن."; }
  return pending.map(target => ({ id: randomBytes(8).toString("hex"), targetUser: target.targetUser, to: target.to, text }));
}

export function createClinicReportJobs({ db, config, now = Date.now }: {
  db: DatabaseSync; config: ClinicReportConfig | (() => ClinicReportConfig); now?: () => number;
}) {
  let running = false;
  const current = () => typeof config === "function" ? config() : config;
  return {
    async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal }) => Promise<unknown>) {
      if (running) return { status: "idle" as const };
      running = true;
      try {
        const at = now();
        const plan = (await planClinicReport(db, current(), at))[0];
        if (!plan) return { status: "idle" as const };
        // Recorded first, so a crash mid-send can never produce a duplicate.
        db.prepare("INSERT OR REPLACE INTO agent_followups (id,kind,target_user,entity_id,sent_at,response) VALUES (?,?,?,NULL,?,'sending')").run(plan.id, KIND, plan.targetUser, at);
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([send({ to: plan.to, text: plan.text, messageId: newMessageId(), signal: controller.signal }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("delivery_uncertain")); }, 15_000); })]);
          db.prepare("UPDATE agent_followups SET response='sent' WHERE id=?").run(plan.id);
          return { status: "sent" as const };
        } catch (error) {
          const uncertain = error instanceof Error && error.message === "delivery_uncertain";
          // An uncertain send keeps its row: better a report nobody got than
          // the same report twice in the group.
          if (!uncertain) db.prepare("DELETE FROM agent_followups WHERE id=?").run(plan.id);
          else db.prepare("UPDATE agent_followups SET response='uncertain' WHERE id=?").run(plan.id);
          return { status: uncertain ? "uncertain" as const : "failed" as const };
        } finally { if (timeout) clearTimeout(timeout); }
      } finally { running = false; }
    },
  };
}
