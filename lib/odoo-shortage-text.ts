/**
 * One shortage list, written once.
 *
 * The same list reaches Basim two ways -- the 9am report and an answer to
 * someone asking in the chat -- and until 2026-09-22 each way formatted it
 * itself. The report was changed to a message per branch; the answer was not,
 * and kept sending all four branches in one message. Basim, on receiving it:
 * "ياعمري قلتلك الف مره كل فرع برساله لحال".
 *
 * So neither caller formats anything any more. Both call
 * branchShortageMessages, and a change to the shape reaches both or neither.
 */
import type { BranchShortages, ShortageItem } from "./odoo-client.ts";

const clean = (value: string) =>
  value.replace(new RegExp("[\\x00-\\x09\\x0b-\\x1f\\u202a-\\u202e\\u2066-\\u2069]", "g"), " ").slice(0, 4000);

// Basim, 2026-09-20, on the packs-with-decimals view: "اكتب فوق الصنف الصنف
// وفوق الاعداد المتوفر الان". Two lines per item -- an English product name
// and an Arabic quantity on ONE line are laid out by WhatsApp's own bidi
// rules and come out scrambled -- and the quantity in packs, never pieces.
export function packLabel(packs: number): string {
  if (!Number.isFinite(packs) || packs <= 0) return "صفر";
  const rounded = Math.round(packs * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "");
}

// WhatsApp swallows anything past a few thousand characters, and a silently
// cut list is the exact failure this whole change is undoing -- so a branch
// with more items than one message holds becomes two messages, not a stump.
export const ITEMS_PER_MESSAGE = 40;

export function shortagesText(branchName: string, items: readonly ShortageItem[], part: number, parts: number): string {
  const header = parts > 1 ? `📦 *نواقص ${branchName}* (${part}/${parts})` : `📦 *نواقص ${branchName}*`;
  const lines = [header, "_رح تخلص خلال أسبوع — العدد بالعلبة_", ""];
  const offset = (part - 1) * ITEMS_PER_MESSAGE;
  items.forEach((item, index) => {
    lines.push(`*${offset + index + 1}.* ${clean(item.name)}`, `المتوفر: *${packLabel(item.packs)}*`, "");
  });
  return clean(lines.join("\n"));
}

export function shortagesFooter(total: number, out: number): string {
  return ["━━━━━━━━━━━━━", `📋 المجموع: ${total} صنف${out ? ` — منهم ${out} نافد` : ""}`].join("\n");
}

export const NO_SHORTAGES = "📦 ما في صنف متحرّك رح يخلص خلال أسبوع بأي فرع.";

/**
 * One message per branch -- never one message carrying several branches --
 * and a second message for a branch whose list outgrows ITEMS_PER_MESSAGE.
 * `entityId` is what the report's already-sent bookkeeping keys on, so a
 * branch that was delivered is not delivered again; callers with no such
 * bookkeeping can ignore it and take `text`.
 */
export function branchShortageMessages(
  branches: readonly BranchShortages[],
  names: Record<string, string>,
): { entityId: string; text: string }[] {
  const messages: { entityId: string; text: string }[] = [];
  for (const branch of branches) {
    const label = names[branch.code] ? `فرع ${names[branch.code]}` : branch.location;
    const out = branch.items.filter(item => item.packs <= 0).length;
    const parts = Math.max(1, Math.ceil(branch.items.length / ITEMS_PER_MESSAGE));
    for (let part = 1; part <= parts; part += 1) {
      const slice = branch.items.slice((part - 1) * ITEMS_PER_MESSAGE, part * ITEMS_PER_MESSAGE);
      const body = shortagesText(label, slice, part, parts);
      messages.push({
        entityId: parts > 1 ? `${branch.code}#${part}` : branch.code,
        text: part === parts ? `${body}${shortagesFooter(branch.items.length, out)}` : body,
      });
    }
  }
  return messages;
}
