/**
 * A composed, read-only query against the pharmacy's own Odoo database, and
 * the validator that decides whether it is allowed to run at all.
 *
 * Basim (2026-09-17): "بدي البوت والسيرفر يوصلو لكل قاعدة البيانات باستمرار
 * بشكل لايف" -- the six hand-written questions were never going to cover what
 * he actually wants to ask. So the model may now compose a query over any
 * table. What it may NOT do is any of the following, and this file is where
 * that is enforced rather than hoped for:
 *
 *   - It never writes. Three read methods exist here and no others; there is
 *     no create/write/unlink path anywhere in the file, on purpose.
 *   - It never hand-writes SQL, a method name, or a URL. It fills a fixed
 *     shape, and every part of that shape is checked against this file.
 *   - A malformed query is REFUSED, never repaired. Quietly fixing a query
 *     means answering a question nobody asked, which is the exact failure
 *     this whole design is built to avoid.
 *
 * Access is not decided here. Each person queries through their OWN Odoo
 * credentials, so Odoo's own record rules decide what comes back -- which is
 * what Basim asked for when he said "كل واحد حسب صلاحيته لانهم الهم يوزرات
 * مثلي". A table this file happily accepts can still return nothing at all,
 * and that is Odoo answering, correctly, on its own authority.
 */

export type OdooQueryMethod = "search_read" | "read_group" | "search_count";

export type OdooQuery = {
  model: string;
  method: OdooQueryMethod;
  domain: unknown[];
  fields?: string[];
  groupBy?: string[];
  order?: string;
  limit?: number;
  offset?: number;
};

// A query can only carry this brand by coming out of validateOdooQuery, so a
// caller cannot construct one by hand and hand it to the executor.
declare const checked: unique symbol;
export type SafeOdooQuery = OdooQuery & { readonly [checked]: true };

const MODEL = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
// Odoo walks relations with dots (`lot_id.expiration_date`). Three hops is
// already more than any report here needs, and each hop is a join.
const FIELD = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;
// read_group takes a granularity suffix on date fields: `date_order:month`.
const GROUP_FIELD = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}(?::(?:day|week|month|quarter|year))?$/;
const ORDER = /^[a-z][a-z0-9_]*(?: (?:asc|desc))?(?:, ?[a-z][a-z0-9_]*(?: (?:asc|desc))?)*$/;
const OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<=", "like", "not like", "ilike", "not ilike",
  "=like", "=ilike", "in", "not in", "child_of", "parent_of"]);

const MAX_LEAVES = 25;
const MAX_FIELDS = 15;
const MAX_GROUP_BY = 3;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 50;
const MAX_VALUE_LENGTH = 200;
const MAX_IN_VALUES = 200;

function scalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= MAX_VALUE_LENGTH;
}

function leaf(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [field, operator, operand] = value;
  if (typeof field !== "string" || !FIELD.test(field)) return false;
  if (typeof operator !== "string" || !OPERATORS.has(operator)) return false;
  // Odoo itself tolerates `in` with a bare value, but a query that reaches for
  // a set and hands over one item is a query that was built wrong, and the
  // number it returns would look exactly like a correct one.
  if (operator === "in" || operator === "not in") {
    return Array.isArray(operand) && operand.length <= MAX_IN_VALUES && operand.every(scalar);
  }
  return !Array.isArray(operand) && scalar(operand);
}

function domain(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let leaves = 0;
  for (const item of value) {
    if (item === "&" || item === "|" || item === "!") continue;
    if (!leaf(item)) return false;
    leaves += 1;
  }
  return leaves <= MAX_LEAVES;
}

function names(value: unknown, max: number, pattern: RegExp): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= max
    && value.every(item => typeof item === "string" && pattern.test(item));
}

/**
 * The composed query, or null when any part of it is not allowed. Null is the
 * whole answer: the caller reports that it could not build a safe query and
 * says so, rather than running a corrected one.
 */
export function validateOdooQuery(input: unknown): SafeOdooQuery | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { model, method, domain: where, fields, groupBy, order, limit } = input as Record<string, unknown>;
  if (typeof model !== "string" || !MODEL.test(model) || model.length > 60) return null;
  if (method !== "search_read" && method !== "read_group" && method !== "search_count") return null;
  if (!domain(where)) return null;

  const query: OdooQuery = { model, method, domain: where as unknown[] };

  if (method === "search_count") {
    // Nothing else is meaningful, and silently ignoring the extras would let a
    // query that asked for fields come back as a bare number without saying so.
    if (fields !== undefined || groupBy !== undefined || order !== undefined || limit !== undefined) return null;
    return query as SafeOdooQuery;
  }

  if (fields !== undefined) {
    if (!names(fields, MAX_FIELDS, FIELD)) return null;
    query.fields = fields as string[];
  } else if (method === "read_group") return null; // read_group with nothing to aggregate is not a question

  if (method === "read_group") {
    if (groupBy !== undefined) {
      const empty = Array.isArray(groupBy) && groupBy.length === 0;
      if (!empty && !names(groupBy, MAX_GROUP_BY, GROUP_FIELD)) return null;
    }
    query.groupBy = (groupBy as string[] | undefined) ?? [];
  } else if (groupBy !== undefined) return null;

  if (order !== undefined) {
    if (typeof order !== "string" || order.length > 100 || !ORDER.test(order)) return null;
    query.order = order;
  }

  // A row cap is never optional: an unbounded read of a live pharmacy system
  // is a load problem for them before it is a formatting problem for us.
  if (limit === undefined) query.limit = DEFAULT_LIMIT;
  else if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  else query.limit = limit;

  const offset = (input as Record<string, unknown>).offset;
  if (offset !== undefined) {
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return null;
    query.offset = offset;
  }

  return query as SafeOdooQuery;
}

const OPERATOR_WORDS: Record<string, string> = {
  "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤",
  like: "يحتوي", "not like": "ما يحتوي", ilike: "يحتوي", "not ilike": "ما يحتوي",
  "=like": "يطابق", "=ilike": "يطابق", in: "ضمن", "not in": "مش ضمن",
  child_of: "تحت", parent_of: "فوق",
};

function operandText(value: unknown): string {
  if (value === true) return "نعم";
  if (value === false) return "لأ";
  if (value === null) return "فاضي";
  if (Array.isArray(value)) return "(" + value.slice(0, 8).map(operandText).join("، ") + (value.length > 8 ? "، …" : "") + ")";
  return String(value);
}

/**
 * What the query actually counted, in Arabic, to print under every answer.
 *
 * This is the only thing standing between Basim and a query that is valid,
 * real, and answering a different question than the one he asked -- the model
 * can pick the wrong filter, and a number from the wrong filter looks exactly
 * like a number from the right one. He has to be able to read the filter back.
 */
export function describeOdooQuery(query: OdooQuery): string {
  const lines = [`📋 الجدول: ${query.model}`];
  const conditions = query.domain.filter(item => Array.isArray(item)) as unknown[][];
  if (conditions.length) {
    const parts = conditions.map(([field, operator, operand]) =>
      `${field} ${OPERATOR_WORDS[String(operator)] ?? String(operator)} ${operandText(operand)}`);
    lines.push(`🔎 الفلتر: ${parts.join(" · ")}`);
  } else lines.push("🔎 الفلتر: بدون — كل السجلات");
  if (query.method === "search_count") lines.push("🔢 الناتج: عدد السجلات");
  else if (query.method === "read_group") {
    lines.push(`🔢 الناتج: مجموع ${(query.fields ?? []).join("، ")}${query.groupBy?.length ? ` مجمّع حسب ${query.groupBy.join("، ")}` : ""}`);
  } else lines.push(`🔢 الناتج: ${(query.fields ?? []).join("، ")} — أول ${query.limit} سجل`);
  return lines.join("\n");
}
