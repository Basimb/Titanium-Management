/**
 * The nightly shelf check, one branch per message (Basim, 2026-10-03, after
 * LAMISIL CREAM sat in the system at Naoor for a year and a half with nothing
 * on the shelf): every night at 10, ten items per branch for the staff to look
 * for, drawn from the suspects in odoo-client.ts's branchCountSuspects.
 *
 * An item listed for a branch is not listed there again for COUNT_REPEAT_DAYS,
 * so the list works its way through the suspects instead of repeating the top
 * of it every night. Replies come back in the group, where Basim reads them;
 * nothing here touches stock.
 */
import type { DatabaseSync } from "node:sqlite";
import type { BranchCountSuspects, CountSuspect } from "./odoo-client.ts";
import { clean } from "./odoo-shortage-text.ts";

export const COUNT_PER_BRANCH = 10;
export const COUNT_REPEAT_DAYS = 60;
const DAY = 86_400_000;
// Built from its code point so this file carries no escapes (it is deployed as plain text).
const NL = String.fromCharCode(10);

function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS odoo_cycle_count_items (location_id INTEGER NOT NULL, product_id INTEGER NOT NULL, listed_at INTEGER NOT NULL, PRIMARY KEY (location_id, product_id))");
}

export function recentlyListed(db: DatabaseSync, locationId: number, at: number): Set<number> {
  migrate(db);
  const rows = db.prepare("SELECT product_id FROM odoo_cycle_count_items WHERE location_id=? AND listed_at>?")
    .all(locationId, at - COUNT_REPEAT_DAYS * DAY) as Array<{ product_id: number }>;
  return new Set(rows.map(row => Number(row.product_id)));
}

export function recordListed(db: DatabaseSync, locationId: number, productIds: readonly number[], at: number): void {
  migrate(db);
  const upsert = db.prepare("INSERT INTO odoo_cycle_count_items (location_id,product_id,listed_at) VALUES (?,?,?) ON CONFLICT(location_id,product_id) DO UPDATE SET listed_at=excluded.listed_at");
  for (const id of productIds) upsert.run(locationId, id, at);
}

// Name, then the system's count, then the barcode, each on its own line: an
// English name beside Arabic text is scrambled by WhatsApp's bidi rules.
export function cycleCountText(branchName: string, items: readonly CountSuspect[]): string {
  const lines = [
    `🔎 *جرد الليلة — ${branchName}*`,
    "_دوروا على هاي الأصناف على الرف وتأكدوا إن العدد مزبوط:_",
    "",
  ];
  items.forEach((item, index) => {
    lines.push(`*${index + 1}.* ${clean(item.name)}`, `بالنظام: *${item.systemQty}*`);
    if (item.barcode) lines.push(`باركود: ${clean(item.barcode)}`);
    lines.push("");
  });
  lines.push("━━━━━━━━━━━━━",
    "اللي مش موجود أو عدده غلط، اكتبوا رقمه والعدد الصحيح هون بالجروب. يعطيكم العافية 🙏");
  return clean(lines.join(NL));
}

/** Today's ten per branch, skipping what was listed there lately. */
export function cycleCountMessages(db: DatabaseSync, branches: readonly BranchCountSuspects[], names: Record<string, string>, at: number):
  Array<{ entityId: string; text: string; countItems: { locationId: number; productIds: number[] } }> {
  const messages: Array<{ entityId: string; text: string; countItems: { locationId: number; productIds: number[] } }> = [];
  for (const branch of branches) {
    const skip = recentlyListed(db, branch.locationId, at);
    const items = branch.items.filter(item => !skip.has(item.productId)).slice(0, COUNT_PER_BRANCH);
    if (!items.length) continue;
    const label = names[branch.code] ? `فرع ${names[branch.code]}` : branch.location;
    messages.push({ entityId: `count:${branch.code}`, text: cycleCountText(label, items),
      countItems: { locationId: branch.locationId, productIds: items.map(item => item.productId) } });
  }
  return messages;
}
