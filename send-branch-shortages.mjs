import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openOdooSession, DEFAULT_BRANCH_NAMES } from './lib/odoo-client.ts';
import { enqueueAgentMessage } from './lib/agent-followups.ts';

const cfg = JSON.parse(fs.readFileSync(process.env.CFG, 'utf8'));
const session = await openOdooSession({ url: cfg.ODOO_URL, db: cfg.ODOO_DB, username: cfg.ODOO_USERNAME, apiKey: cfg.ODOO_API_KEY });
const branches = await session.branchShortages({ maxDaysLeft: 7 });

const packLabel = p => {
  if (!Number.isFinite(p) || p <= 0) return "صفر";
  const r = Math.round(p * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, "");
};

const db = new DatabaseSync(process.env.DB);
for (const branch of branches) {
  const name = DEFAULT_BRANCH_NAMES[branch.code];
  const label = name ? "فرع " + name : branch.location;
  const out = branch.items.filter(i => i.packs <= 0).length;
  const lines = ["\u{1F4E6} *نواقص " + label + "*",
    "_رح تخلص خلال أسبوع — العدد بالعلبة_", ""];
  branch.items.forEach((item, i) => lines.push("*" + (i + 1) + ".* " + item.name,
    "المتوفر: *" + packLabel(item.packs) + "*", ""));
  lines.push("━".repeat(13), "\u{1F4CB} المجموع: " + branch.items.length + " صنف"
    + (out ? " — منهم " + out + " نافد" : ""));
  const text = lines.join("\n");
  console.log(text + "\n========================");
  enqueueAgentMessage(db, { toUser: "group", text }, Date.now());
}
console.log("queued " + branches.length + " messages for the group.");
