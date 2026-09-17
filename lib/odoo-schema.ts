/**
 * The map of the pharmacy's database, read from Odoo itself rather than
 * written down here.
 *
 * Basim (2026-09-17): "بدي البوت والسيرفر يوصلو لكل قاعدة البيانات". A fixed
 * list of tables in this repository would go stale the first time Dawatech
 * adds a field, so the catalog comes from ir.model and ir.model.fields on
 * every cold start and is cached after that.
 *
 * It is read through the ASKING PERSON'S session, so the catalog already
 * reflects what Odoo is willing to show them -- the same reason the queries
 * themselves run as that person. Cached per (server, database, user) for that
 * reason: one person's map is not another's.
 */
import type { OdooSession } from "./odoo-client.ts";
import { validateOdooQuery } from "./odoo-query.ts";

export type OdooModelInfo = { model: string; label: string };
export type OdooFieldInfo = { name: string; type: string; label: string };

const CATALOG_TTL_MS = 6 * 60 * 60_000;
const MAX_MODELS = 2000;
const MAX_FIELDS_PER_MODEL = 60;
const models = new Map<string, { at: number; list: OdooModelInfo[] }>();
const fields = new Map<string, Map<string, OdooFieldInfo[]>>();

/** Test seam: forget every cached catalog. */
export function forgetOdooCatalog(): void { models.clear(); fields.clear(); }

// Odoo's own plumbing -- audit trails, view definitions, cron jobs, chatter.
// Left out of the CATALOG because it is noise in a prompt, not because it is
// secret: what a person may read is Odoo's decision, made against their own
// credentials when the query runs.
const PLUMBING = /^(?:ir\.|base\.|bus\.|web_|report\.|mail\.(?:message|notification|tracking|followers)|barcodes\.)/;

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(row => !!row && typeof row === "object") as Array<Record<string, unknown>> : [];
}
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

/**
 * Every table this person can see. Throws only if Odoo is unreachable; a
 * person whose account may read very little simply gets a short catalog,
 * because this is read through THEIR session.
 */
export async function odooCatalog(session: OdooSession, cacheKey: string, now = Date.now()): Promise<OdooModelInfo[]> {
  const cached = models.get(cacheKey);
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.list;
  const query = validateOdooQuery({ model: "ir.model", method: "search_read",
    domain: [["transient", "=", false]], fields: ["model", "name"], order: "model asc", limit: MAX_MODELS });
  if (!query) throw new Error("odoo_catalog_unavailable");
  const list = rows(await session.runQuery(query))
    .map(row => ({ model: text(row.model), label: text(row.name, text(row.model)) }))
    .filter(info => info.model && !PLUMBING.test(info.model));
  models.set(cacheKey, { at: now, list });
  return list;
}

/**
 * The fields of a handful of tables, fetched only for the tables a question
 * turned out to be about. Fetching every field of every table would be ten
 * thousand rows to answer one question about sales.
 */
export async function odooFields(session: OdooSession, cacheKey: string, wanted: string[]): Promise<Map<string, OdooFieldInfo[]>> {
  const known = fields.get(cacheKey) ?? new Map<string, OdooFieldInfo[]>();
  fields.set(cacheKey, known);
  const missing = wanted.filter(model => !known.has(model));
  if (missing.length) {
    const query = validateOdooQuery({ model: "ir.model.fields", method: "search_read",
      domain: [["model", "in", missing], ["store", "=", true]],
      fields: ["model", "name", "ttype", "field_description"], order: "model asc", limit: MAX_MODELS });
    if (!query) throw new Error("odoo_catalog_unavailable");
    for (const model of missing) known.set(model, []);
    for (const row of rows(await session.runQuery(query))) {
      const list = known.get(text(row.model));
      const name = text(row.name);
      if (!list || !name || list.length >= MAX_FIELDS_PER_MODEL) continue;
      list.push({ name, type: text(row.ttype, "char"), label: text(row.field_description, name) });
    }
  }
  return new Map(wanted.map(model => [model, known.get(model) ?? []]));
}

// A catalog of hundreds of tables does not fit in a prompt, and most of it has
// nothing to do with any one question. These are the tables the questions
// actually reach for, ranked first so the model sees them even when the
// question's own words match nothing.
const CORE = ["pos.order", "pos.order.line", "account.move", "account.move.line", "product.product",
  "product.template", "stock.quant", "stock.lot", "stock.location", "stock.move", "stock.picking",
  "res.partner", "stock.warehouse.orderpoint", "product.supplierinfo", "purchase.order", "sale.order"];

/** The tables worth showing the model for THIS question. */
export function pickModels(catalog: OdooModelInfo[], question: string, max = 20): string[] {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}_.]+/u).filter(word => word.length > 2);
  const rank = (info: OdooModelInfo): number => {
    const core = CORE.indexOf(info.model);
    if (core >= 0) return 100 - core;
    const haystack = `${info.model} ${info.label}`.toLowerCase();
    return words.some(word => haystack.includes(word)) ? 10 : 0;
  };
  return catalog.map(info => ({ info, score: rank(info) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(entry => entry.info.model);
}

/** The slice of the database map that goes into the prompt, as text. */
export async function promptCatalog(session: OdooSession, cacheKey: string, question: string, max = 20): Promise<string> {
  const catalog = await odooCatalog(session, cacheKey);
  const wanted = pickModels(catalog, question, max);
  const byModel = await odooFields(session, cacheKey, wanted);
  const labels = new Map(catalog.map(info => [info.model, info.label]));
  return wanted
    .filter(model => (byModel.get(model) ?? []).length > 0)
    .map(model => `${model} (${labels.get(model) ?? model}): `
      + (byModel.get(model) ?? []).map(field => `${field.name}:${field.type}`).join(", "))
    .join("\n");
}
