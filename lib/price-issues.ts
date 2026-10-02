/**
 * The last list of items sold at a loss or near it, kept so a task about
 * prices can carry it.
 *
 * Basim, 2026-10-02: the morning list goes to the group and tells Dr. Shadi
 * to send the secretary "1" in private and write the task. But the private
 * conversation never saw the group message, so the task would open with only
 * the few words he typed -- "ما حتقتبس له الاسعار من الجروب". The report job
 * records the list here when it is sent, and the secretary attaches it to a
 * price task opened within the next day and a half.
 */
import type { DatabaseSync } from "node:sqlite";

const KEEP_MS = 36 * 60 * 60_000;

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS odoo_price_issues (
    id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL, items TEXT NOT NULL, sent_at INTEGER NOT NULL)`);
}

export function recordPriceIssues(db: DatabaseSync, day: string, items: string, at: number): void {
  migrate(db);
  db.prepare(`INSERT INTO odoo_price_issues (id, day, items, sent_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET day=excluded.day, items=excluded.items, sent_at=excluded.sent_at`).run(day, items, at);
}

export function latestPriceIssues(db: DatabaseSync, now: number): { day: string; items: string } | null {
  migrate(db);
  const row = db.prepare("SELECT day, items, sent_at FROM odoo_price_issues WHERE id=1").get() as { day: string; items: string; sent_at: number } | undefined;
  return row && now - row.sent_at <= KEEP_MS ? { day: row.day, items: row.items } : null;
}

const PRICE_TASK = /سعر|اسعار|أسعار|تسعير|الربح|خسار/;

/** The task's details with the list added, when the task is about prices and a list is fresh. */
export function withPriceIssues(db: DatabaseSync, title: string | null, details: string | null, now: number): string | null {
  if (!PRICE_TASK.test(`${title ?? ""} ${details ?? ""}`)) return details;
  const latest = latestPriceIssues(db, now);
  if (!latest || (details ?? "").includes(latest.items)) return details;
  const block = `الأصناف من قائمة مشاكل الربح (مبيعات ${latest.day}):\n${latest.items}`;
  return details ? `${details}\n\n${block}` : block;
}
