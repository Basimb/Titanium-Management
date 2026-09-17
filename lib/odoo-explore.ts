/**
 * The open question: any table, any filter, live.
 *
 * Basim (2026-09-17): "بدي البوت والسيرفر يوصلو لكل قاعدة البيانات باستمرار
 * بشكل لايف". The six hand-written questions stay exactly as they are -- they
 * are the ones he acts on every day and they never touch a model. This is the
 * layer underneath them, for everything else.
 *
 * The split that makes it safe is the same one as everywhere else in this
 * feature, one notch wider: the model composes a QUERY, never an answer. It
 * fills a fixed shape, lib/odoo-query.ts refuses anything outside that shape,
 * and the numbers come back from Odoo. What the model can still get wrong is
 * the FILTER -- and a number from the wrong filter looks exactly like a number
 * from the right one -- so every answer prints what it counted underneath.
 */
import { promptCatalog } from "./odoo-schema.ts";
import { validateOdooQuery, describeOdooQuery, type SafeOdooQuery } from "./odoo-query.ts";
import { formatAmount, type OdooSession } from "./odoo-client.ts";

const AMMAN_OFFSET_MINUTES = 180;
const MAX_LINES = 15;

const rules = (catalog: string, today: string) => [
  "You turn one question from the owner of a Jordanian pharmacy chain into ONE read-only Odoo 16 query.",
  "The question is in Jordanian Arabic, sometimes English or mixed.",
  "",
  "Tables you may use, with their stored fields and types:",
  catalog,
  "",
  `Today is ${today} (Asia/Amman, UTC+3). Datetime fields are stored in UTC: subtract 3 hours from a local time.`,
  "",
  "Answer with JSON only, in exactly this shape:",
  '{"model":"<table>","method":"search_count"|"read_group"|"search_read",'
    + '"domain":[[field,operator,value],...],"fields":[...],"groupBy":[...],"order":"field asc","limit":50}',
  "",
  "Rules:",
  "- search_count for 'how many'. read_group with fields=[numeric field] for a total or a breakdown.",
  "  search_read to list actual records.",
  "- fields is required except for search_count. groupBy belongs to read_group only.",
  "- search_count takes NO fields, groupBy, order or limit.",
  "- `in` and `not in` always take a list.",
  "- Only fields listed above for that table, or a relation walked with a dot.",
  "- Sales through the till are pos.order with state in ['paid','done','invoiced'].",
  "  Invoices are account.move with state='posted' and the right move_type",
  "  (out_invoice = customer, in_invoice = vendor bill, in_refund = vendor credit note).",
  "  Stock actually on a shelf is stock.quant with location_id.usage='internal' and quantity>0.",
  '- If the question cannot be answered by ONE query over these tables, answer {"none":true}. Never guess.',
  "- Never explain. JSON only.",
].join("\n");

/** The query this question asks for, or null. Never throws. */
export async function composeOdooQuery(question: string, catalog: string,
  options: { apiKey?: string; model?: string; fetcher?: typeof fetch; now?: number }): Promise<SafeOdooQuery | null> {
  if (!options.apiKey || !question.trim() || question.length > 300 || !catalog) return null;
  const today = new Date((options.now ?? Date.now()) + AMMAN_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
  try {
    const response = await (options.fetcher || fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model || "gpt-4o", max_completion_tokens: 500, temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: rules(catalog, today) }, { role: "user", content: question.trim() }],
      }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > 4000) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return null; }
    // A refusal to compose is an answer, and a valid one.
    if (parsed && typeof parsed === "object" && (parsed as { none?: unknown }).none) return null;
    return validateOdooQuery(parsed);
  } catch { return null; }
}

const NUMERIC = /(amount|qty|quantity|price|total|count|residual|balance|credit|debit|weight|volume)/;
function display(value: unknown, field: string, currency?: string): string {
  if (value === null || value === undefined || value === false) return "—";
  if (Array.isArray(value)) return typeof value[1] === "string" ? value[1] : String(value[0] ?? "—");
  if (typeof value === "number") return NUMERIC.test(field) ? formatAmount(value) + (currency ? ` ${currency}` : "") : String(value);
  if (typeof value === "boolean") return value ? "نعم" : "لأ";
  return String(value).slice(0, 80);
}

/** The result, as lines a person reads. The footer is added by the caller. */
export function formatOdooResult(query: SafeOdooQuery, result: unknown, currency?: string): string {
  if (query.method === "search_count") {
    return `🔢 *${typeof result === "number" ? result.toLocaleString("en-US") : "—"}*`;
  }
  const rows = Array.isArray(result) ? result.filter(row => !!row && typeof row === "object") as Array<Record<string, unknown>> : [];
  if (!rows.length) return "ما في ولا سجل بهاي الفلترة.";

  if (query.method === "read_group") {
    const aggregates = query.fields ?? [];
    const groups = query.groupBy ?? [];
    if (!groups.length) {
      const row = rows[0];
      const parts = aggregates.map(field => `${field}: *${display(row[field], field, currency)}*`);
      return [`🔢 عدد السجلات: *${Number(row.__count ?? row[`${groups[0]}_count`] ?? 0)}*`, ...parts].join("\n");
    }
    const key = groups[0].split(":")[0];
    const lines = rows.slice(0, MAX_LINES).map(row => {
      const label = display(row[groups[0]] ?? row[key], key);
      const values = aggregates.map(field => display(row[field], field, currency)).join(" · ");
      return `• ${label} — ${values} (${Number(row.__count ?? 0)} سجل)`;
    });
    if (rows.length > MAX_LINES) lines.push(`… و${rows.length - MAX_LINES} أكثر`);
    return lines.join("\n");
  }

  const fields = (query.fields ?? []).slice(0, 4);
  const lines = rows.slice(0, MAX_LINES).map(row =>
    "• " + fields.map(field => display(row[field], field, currency)).join(" — "));
  if (rows.length > MAX_LINES) lines.push(`… و${rows.length - MAX_LINES} أكثر`);
  return lines.join("\n");
}

/**
 * Answer one open question, or return null so the message carries on to the
 * ordinary secretary. Runs entirely as the asking person: the session handed
 * in was opened with THEIR Odoo credentials, so Odoo's own record rules decide
 * what comes back.
 */
export async function exploreOdoo(question: string, dependencies: {
  session: OdooSession; cacheKey: string; apiKey?: string; model?: string;
  fetcher?: typeof fetch; currencyLabel?: string; now?: number;
}): Promise<string | null> {
  let catalog: string;
  try { catalog = await promptCatalog(dependencies.session, dependencies.cacheKey, question); }
  catch { return null; }
  if (!catalog) return null;
  const query = await composeOdooQuery(question, catalog, dependencies);
  if (!query) return null;
  const result = await dependencies.session.runQuery(query);
  return `${formatOdooResult(query, result, dependencies.currencyLabel)}\n\n${describeOdooQuery(query)}`;
}
