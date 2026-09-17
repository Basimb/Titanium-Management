/**
 * Routing only. Basim (2026-09-17): "بدي يصير الذكاء يربط الاسئله انها مبيعات
 * وهيك" -- he should be able to ask in any wording and be understood, without
 * the model being anywhere near the figures.
 *
 * So this file does exactly one thing: it turns a free-text message into one
 * of the question kinds that lib/odoo-questions.ts already knows how to
 * answer, plus a branch code, or into nothing at all. The reply the user sees
 * is still built by answerOdooQuestion from a real Odoo query. Nothing the
 * model returns is ever shown, quoted, or arithmetically used -- an answer it
 * cannot route simply falls through to the ordinary secretary.
 *
 * The message text is the only thing sent: no task catalog, no employee
 * table, no figures, no history.
 */
import type { OdooQuestionKind, OdooQuestionMatch } from "./odoo-questions.ts";

const KINDS: readonly OdooQuestionKind[] = ["sales_today", "sales_yesterday", "sales_week", "sales_month",
  "shifts_today", "shifts_yesterday", "low_stock", "expiring", "unpaid_bills", "purchases_month", "help"];
const BRANCHES = ["NAOOR", "SAFOT", "DABOQ", "JUMRK"] as const;

const PROMPT = [
  "You route one WhatsApp message from the owner of a Jordanian pharmacy chain to exactly one report, or to none.",
  "The message is in Jordanian Arabic, sometimes in English or mixed.",
  "",
  "Kinds:",
  "  sales_today      - takings/sales/revenue so far today",
  "  sales_yesterday  - sales for yesterday",
  "  sales_week       - sales over the last week",
  "  sales_month      - sales this month / since the start of the month",
  "  shifts_today     - today's sales split by work shift (morning 08-16, evening 16-24, night 00-08)",
  "  shifts_yesterday - the same for yesterday",
  "  low_stock        - which items are running out / nearly out of stock",
  "  expiring         - stock that has expired or expires soon",
  "  unpaid_bills     - unpaid or outstanding VENDOR bills, what the company owes suppliers",
  "  purchases_month  - what was purchased from vendors this month, net of vendor returns",
  "  help             - asking what questions can be answered at all",
  "  none             - anything else, INCLUDING: creating/assigning/closing a task, a message to a person,",
  "                     chit-chat, a question about people, salaries, schedules, or anything not in the list.",
  "",
  "Branches (return the code only if the message names one): NAOOR الناعور, SAFOT صافوط, DABOQ دابوق, JUMRK الجمرك.",
  "",
  'Reply with JSON only: {"kind":"<one of the kinds or none>","branch":"<code or null>"}',
  "When unsure, answer none. Never explain. Never invent a kind.",
].join("\n");

function parse(content: unknown): OdooQuestionMatch | null {
  if (typeof content !== "string" || content.length > 400) return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, branch } = value as { kind?: unknown; branch?: unknown };
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return null;
  const code = typeof branch === "string" ? branch.toUpperCase() : null;
  return { kind: kind as OdooQuestionKind, branch: code && (BRANCHES as readonly string[]).includes(code) ? code : null };
}

/** The question this message is asking, as the model reads it, or null. Never throws. */
export async function classifyOdooQuestion(text: string,
  options: { apiKey?: string; model?: string; fetcher?: typeof fetch }): Promise<OdooQuestionMatch | null> {
  const message = text.trim();
  // Long messages are not questions of this kind, and a message carrying a
  // phone number or an address is one the secretary should handle, not this.
  if (!options.apiKey || !message || message.length > 200) return null;
  try {
    const response = await (options.fetcher || fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model || "gpt-4o-mini",
        // Small and bounded: the reply is one short JSON object, so a slow or
        // rambling answer is a failure to route, not something to wait for.
        max_completion_tokens: 40, temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: PROMPT }, { role: "user", content: message }],
      }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
    return parse(choice?.message?.content);
  } catch {
    // Unreachable, slow, rate-limited, rejected: the message simply was not a
    // routed question, and the ordinary secretary takes it from here.
    return null;
  }
}
