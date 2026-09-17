/**
 * Minimal, read-only client for the pharmacy's own Odoo instance (external
 * JSON-RPC API). Used only to read sales and inventory numbers for the
 * periodic report -- there is no create/write/unlink call anywhere in this
 * file, on purpose: a WhatsApp-triggered report must never be able to change
 * anything in the pharmacy's real business system.
 */

import type { SafeOdooQuery } from "./odoo-query.ts";

export type OdooConfig = { url: string; db: string; username: string; apiKey: string };
type Fetcher = typeof fetch;

export class OdooError extends Error {
  constructor(message: string) { super(message); this.name = "OdooError"; }
}

function assertConfig(config: OdooConfig): void {
  if (!/^https:\/\/[\w.-]+(?::\d+)?$/.test(config.url) || !config.db.trim() || !config.username.trim() || !config.apiKey.trim()) {
    throw new OdooError("odoo_config_invalid");
  }
}

async function call(config: OdooConfig, service: "common" | "object", method: string, args: unknown[], fetcher: Fetcher): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${config.url}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: null }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch { throw new OdooError("odoo_unreachable"); }
  if (!response.ok) throw new OdooError("odoo_http_error");
  let json: unknown;
  try { json = await response.json(); } catch { throw new OdooError("odoo_invalid_response"); }
  if (!json || typeof json !== "object") throw new OdooError("odoo_invalid_response");
  const body = json as { error?: unknown; result?: unknown };
  if (body.error) throw new OdooError("odoo_rpc_error");
  return body.result;
}

async function authenticate(config: OdooConfig, fetcher: Fetcher): Promise<number> {
  const result = await call(config, "common", "authenticate", [config.db, config.username, config.apiKey, {}], fetcher);
  if (!Number.isInteger(result) || (result as number) <= 0) throw new OdooError("odoo_authentication_failed");
  return result as number;
}

// Basim (2026-09-17): "بدي يصير جاوبني بسرعه فائقه". Every live question used
// to spend a full round trip logging in before it could ask anything, and the
// login is the slowest call Odoo serves -- it is the only one that touches the
// user table. The uid it returns does not change, so it is worth keeping.
//
// Cached per (server, database, user) AND per fetcher: tests pass their own
// fetcher and must never inherit a uid another test's stub handed out. A
// rejected uid (password rotated, session invalidated server-side) drops the
// entry and the caller authenticates again, so a stale uid costs one retry
// rather than a broken answer.
const UID_TTL_MS = 30 * 60_000;
const uidCache = new Map<string, { uid: number; at: number; fetcher: Fetcher }>();
const uidKey = (config: OdooConfig) => `${config.url}|${config.db}|${config.username}`;

async function cachedUid(config: OdooConfig, fetcher: Fetcher, now: number): Promise<{ uid: number; reused: boolean }> {
  const key = uidKey(config);
  const cached = uidCache.get(key);
  if (cached && cached.fetcher === fetcher && now - cached.at < UID_TTL_MS) return { uid: cached.uid, reused: true };
  const uid = await authenticate(config, fetcher);
  uidCache.set(key, { uid, at: now, fetcher });
  return { uid, reused: false };
}

/** Test seam: forget every cached login, so a test starts from a clean slate. */
export function forgetOdooSessions(): void { uidCache.clear(); }

// Odoo returns the row count under `__count` when read_group is called with
// lazy:false, and under `<groupby>_count` when it is lazy -- which is the
// default. Reading only `__count` is how a grouped report ends up saying zero
// operations next to a correct amount. Both are accepted here so a caller that
// forgets the kwarg is merely slower, never wrong.
function groupCount(row: Record<string, unknown>, groupBy?: string): number {
  const candidates = [row.__count, groupBy ? row[`${groupBy}_count`] : undefined, row.__domain_count];
  for (const value of candidates) {
    const count = Number(value);
    if (Number.isFinite(count)) return count;
  }
  return 0;
}

function formatAmount(value: number): string {
  const fixed = (Number.isFinite(value) ? value : 0).toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withSeparators}.${fraction}`;
}

// A till refund is stored as an order with a negative total in the very same
// states, so it nets out of totalAmount correctly -- but counting it as an
// "operation" drags the average basket below the truth. Kept apart, so a
// report can show both and mean both.
export type SalesSummary = { orderCount: number; totalAmount: number; refundCount: number; refundAmount: number };
// Sales that never touch the till: posted customer invoices. Insurance,
// corporate accounts and the clinics bill this way, and every figure in this
// file used to miss them entirely.
export type InvoiceSales = { invoiceCount: number; totalAmount: number };
// Measured on the live system, 2026-09-17: the catalogue holds 60,452 saleable
// products, only 13,540 of which have any stock at all -- and 10,896 of THOSE
// sit at ten units or fewer, because a pharmacy carries one or two of most
// things by design. So "under ten" is not a shortage, it is the normal state
// of the shelf, and a list built on it is 46,912 items of catalogue plus the
// entire long tail. What matters is how long the stock lasts: quantity divided
// by how fast the item actually sells.
export type ShortageItem = { name: string; qty: number; perDay: number; daysLeft: number };
export type LocationSales = { location: string; orderCount: number; totalAmount: number };
// Basim (2026-09-17): the three shifts the branches run -- 08:00-16:00,
// 16:00-24:00, and 00:00-08:00, all Amman time. Each belongs to the calendar
// day it falls in, so Wednesday's night shift is the small hours of Wednesday
// morning. Odoo stores date_order in UTC, so every boundary here is the local
// hour minus the offset: 08:00 in the pharmacy is 05:00 in the database, and
// a shift report that forgets that is wrong by three hours while looking right.
export type ShiftName = "morning" | "evening" | "night";
export type ShiftSales = { shift: ShiftName; orderCount: number; totalAmount: number; byLocation: LocationSales[] };
// "مشتريات" = posted vendor bills (account.move, move_type=in_invoice); "مرتجعات
// للموردين" = posted vendor credit notes (move_type=in_refund) -- confirmed
// 2026-09-12 with Basim ("مرتجعات للموردين", not customer/POS returns).
export type PurchaseSummary = { purchaseCount: number; purchaseAmount: number; returnCount: number; returnAmount: number };

// Basim (2026-09-16), after the first look at his live data: 2,767 stock lines
// holding 11,829 units whose expiry date has already passed, still sitting in
// internal locations. Counting LOTS would have overstated it wildly (68,330
// lots exist, 13,997 of them expired) -- a lot record outlives the stock it
// described. These read stock.quant instead, filtered to internal locations
// and a positive quantity, so the number is what is actually on a shelf.
export type ExpirySummary = { expiredLines: number; expiredQty: number; soonLines: number; soonQty: number; withinDays: number };
export type PayablesSummary = { billCount: number; billTotal: number; creditCount: number; creditTotal: number };

export type OdooSession = {
  // The composed-query escape hatch. It takes only a SafeOdooQuery, which
  // nothing but validateOdooQuery can produce, so the widening below cannot be
  // reached with a query that was never checked. Still read-only: the three
  // methods it forwards are the three the validator admits.
  runQuery(query: SafeOdooQuery): Promise<unknown>;
  salesSummary(sinceIso: string, untilIso: string): Promise<SalesSummary>;
  invoiceSales(sinceIso: string, untilIso: string): Promise<InvoiceSales>;
  salesByLocation(sinceIso: string, untilIso: string): Promise<LocationSales[]>;
  /** Any window, split into the three shifts by local clock time. */
  salesByShift(sinceMs: number, untilMs: number, offsetMinutes?: number): Promise<ShiftSales[]>;
  purchaseSummary(sinceIso: string, untilIso: string): Promise<PurchaseSummary>;
  /** Items that run out soonest, by days of cover. See ShortageItem. */
  shortages(options?: { windowDays?: number; maxDaysLeft?: number; limit?: number; at?: number }): Promise<ShortageItem[]>;
  activeProductCount(): Promise<number>;
  expirySummary(withinDays: number, at?: number): Promise<ExpirySummary>;
  openPayables(): Promise<PayablesSummary>;
};

/** Authenticates once, then reuses that session for every read below. */
export async function openOdooSession(config: OdooConfig, fetcher: Fetcher = fetch,
  now: () => number = Date.now): Promise<OdooSession> {
  assertConfig(config);
  let { uid, reused } = await cachedUid(config, fetcher, now());
  const execute = async (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> => {
    try {
      return await call(config, "object", "execute_kw", [config.db, uid, config.apiKey, model, method, args, kwargs], fetcher);
    } catch (error) {
      // Only a uid that was handed to us by an earlier request can be stale, and
      // only once: after re-authenticating, a second failure is the real error.
      if (!reused || !(error instanceof OdooError)) throw error;
      reused = false;
      uidCache.delete(uidKey(config));
      ({ uid } = await cachedUid(config, fetcher, now()));
      return call(config, "object", "execute_kw", [config.db, uid, config.apiKey, model, method, args, kwargs], fetcher);
    }
  };
  const locationSales = async (sinceIso: string, untilIso: string): Promise<LocationSales[]> => {
    const domain = [["date_order", ">=", sinceIso], ["date_order", "<", untilIso], ["state", "in", ["paid", "done", "invoiced"]]];
    const groups = (await execute("pos.order", "read_group", [domain, ["amount_total"], ["location_id"]], { lazy: false })) as Array<Record<string, unknown>> | undefined;
    return (Array.isArray(groups) ? groups : []).map(row => {
      const locationId = row.location_id;
      const location = Array.isArray(locationId) && typeof locationId[1] === "string" ? locationId[1] : "?";
      return { location, orderCount: groupCount(row, "location_id"), totalAmount: Number(row.amount_total ?? 0) };
    });
  };

  return {
    async runQuery(query) {
      if (query.method === "search_count") return execute(query.model, "search_count", [query.domain]);
      if (query.method === "read_group") {
        return execute(query.model, "read_group", [query.domain, query.fields ?? [], query.groupBy ?? []],
          { lazy: false, limit: query.limit ?? 50 });
      }
      return execute(query.model, "search_read", [query.domain, query.fields ?? []],
        { limit: query.limit ?? 50, ...(query.offset ? { offset: query.offset } : {}),
          ...(query.order ? { order: query.order } : {}) });
    },
    async salesSummary(sinceIso, untilIso) {
      const window: unknown[] = [["date_order", ">=", sinceIso], ["date_order", "<", untilIso], ["state", "in", ["paid", "done", "invoiced"]]];
      const read = async (extra: unknown[]) => {
        const groups = (await execute("pos.order", "read_group", [[...window, ...extra], ["amount_total"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
        const row = Array.isArray(groups) ? groups[0] : undefined;
        return { count: row ? groupCount(row) : 0, amount: Number(row?.amount_total ?? 0) };
      };
      const [sales, refunds] = await Promise.all([read([["amount_total", ">=", 0]]), read([["amount_total", "<", 0]])]);
      return {
        orderCount: sales.count, refundCount: refunds.count,
        // The total is still everything net of refunds -- only the counts split.
        totalAmount: sales.amount + refunds.amount, refundAmount: Math.abs(refunds.amount),
      };
    },
    async invoiceSales(sinceIso, untilIso) {
      // invoice_date is a Date field, not a datetime: compare on YYYY-MM-DD,
      // inclusive at the start and exclusive at the end, to match the till
      // window this sits beside.
      const since = sinceIso.slice(0, 10), until = untilIso.slice(0, 10);
      const domain = [["move_type", "=", "out_invoice"], ["state", "=", "posted"],
        ["invoice_date", ">=", since], ["invoice_date", "<", until]];
      const groups = (await execute("account.move", "read_group", [domain, ["amount_total"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
      const row = Array.isArray(groups) ? groups[0] : undefined;
      return { invoiceCount: row ? groupCount(row) : 0, totalAmount: Number(row?.amount_total ?? 0) };
    },
    salesByLocation: locationSales,
    async salesByShift(sinceMs, untilMs, offsetMinutes = 180) {
      // A shift is contiguous within one day, but "the morning shift this
      // month" is thirty separate stretches. Rather than thirty reads, the
      // orders themselves are read once and bucketed by their local hour --
      // which is also the only place the UTC-to-Amman conversion happens.
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < 40_000; offset += 2000) {
        const page = (await execute("pos.order", "search_read",
          [[["date_order", ">=", new Date(sinceMs).toISOString()], ["date_order", "<", new Date(untilMs).toISOString()],
            ["state", "in", ["paid", "done", "invoiced"]]], ["date_order", "amount_total", "location_id"]],
          { limit: 2000, offset, order: "id asc" })) as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(page) || !page.length) break;
        rows.push(...page);
        if (page.length < 2000) break;
      }

      const buckets = new Map<ShiftName, Map<string, LocationSales>>([
        ["morning", new Map()], ["evening", new Map()], ["night", new Map()],
      ]);
      for (const row of rows) {
        // Odoo hands back "YYYY-MM-DD HH:MM:SS" in UTC, with no zone marker.
        const stamp = typeof row.date_order === "string" ? Date.parse(row.date_order.replace(" ", "T") + "Z") : NaN;
        if (!Number.isFinite(stamp)) continue;
        const localHour = new Date(stamp + offsetMinutes * 60_000).getUTCHours();
        const shift: ShiftName = localHour >= 8 && localHour < 16 ? "morning" : localHour >= 16 ? "evening" : "night";
        const locationId = row.location_id;
        const location = Array.isArray(locationId) && typeof locationId[1] === "string" ? locationId[1] : "?";
        const bucket = buckets.get(shift)!;
        const entry = bucket.get(location) ?? { location, orderCount: 0, totalAmount: 0 };
        entry.orderCount += 1;
        entry.totalAmount += Number(row.amount_total) || 0;
        bucket.set(location, entry);
      }

      return (["morning", "evening", "night"] as ShiftName[]).map(shift => {
        const byLocation = [...buckets.get(shift)!.values()];
        return {
          shift,
          orderCount: byLocation.reduce((sum, row) => sum + row.orderCount, 0),
          totalAmount: byLocation.reduce((sum, row) => sum + row.totalAmount, 0),
          byLocation,
        };
      });
    },
    async purchaseSummary(sinceIso, untilIso) {
      // account.move's invoice_date is an Odoo Date field, not a datetime --
      // compare on the plain YYYY-MM-DD portion, inclusive on both ends.
      const since = sinceIso.slice(0, 10), until = untilIso.slice(0, 10);
      const domain = (moveType: string) => [["move_type", "=", moveType], ["state", "=", "posted"], ["invoice_date", ">=", since], ["invoice_date", "<=", until]];
      const [purchases, returns] = await Promise.all([
        execute("account.move", "read_group", [domain("in_invoice"), ["amount_total"], []]) as Promise<Array<Record<string, unknown>> | undefined>,
        execute("account.move", "read_group", [domain("in_refund"), ["amount_total"], []]) as Promise<Array<Record<string, unknown>> | undefined>,
      ]);
      const purchaseRow = Array.isArray(purchases) ? purchases[0] : undefined;
      const returnRow = Array.isArray(returns) ? returns[0] : undefined;
      return {
        purchaseCount: purchaseRow ? groupCount(purchaseRow) : 0, purchaseAmount: Number(purchaseRow?.amount_total ?? 0),
        returnCount: returnRow ? groupCount(returnRow) : 0, returnAmount: Number(returnRow?.amount_total ?? 0),
      };
    },
    async expirySummary(withinDays, at = Date.now()) {
      // Odoo renamed stock.production.lot to stock.lot in 16.0; this instance
      // is 16.0 (verified against the live server), and the domain walks
      // lot_id.expiration_date rather than reading lots directly so that a lot
      // with no stock left simply does not appear.
      // "Today" is the pharmacy's today, not the server's: between midnight and
      // 3am in Amman the UTC date is still yesterday's, and an item expiring
      // today would land in the wrong bucket. It is also the moment the question
      // was asked, never the moment this line happens to run.
      const day = 86_400_000, amman = 180 * 60_000;
      const local = (ms: number) => new Date(ms + amman).toISOString().slice(0, 10);
      const today = local(at);
      const until = local(at + withinDays * day);
      const internal: unknown[] = [["location_id.usage", "=", "internal"], ["quantity", ">", 0]];
      const read = async (extra: unknown[]) => {
        const groups = (await execute("stock.quant", "read_group", [[...internal, ...extra], ["quantity"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
        const row = Array.isArray(groups) ? groups[0] : undefined;
        return { lines: row ? groupCount(row) : 0, qty: Number(row?.quantity ?? 0) };
      };
      const [expired, soon] = await Promise.all([
        read([["lot_id.expiration_date", "<", today]]),
        read([["lot_id.expiration_date", ">=", today], ["lot_id.expiration_date", "<=", until]]),
      ]);
      return { expiredLines: expired.lines, expiredQty: expired.qty, soonLines: soon.lines, soonQty: soon.qty, withinDays };
    },
    async openPayables() {
      // Posted vendor bills that are still unpaid or only part-paid -- and the
      // unpaid credit notes that reduce what is actually owed. Counting only
      // the bills, as this did, reads high by exactly the credit notes.
      const open = (moveType: string) => [["move_type", "=", moveType], ["state", "=", "posted"],
        ["payment_state", "in", ["not_paid", "partial"]]];
      const read = async (moveType: string) => {
        const groups = (await execute("account.move", "read_group", [open(moveType), ["amount_residual"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
        const row = Array.isArray(groups) ? groups[0] : undefined;
        return { count: row ? groupCount(row) : 0, total: Number(row?.amount_residual ?? 0) };
      };
      const [bills, credits] = await Promise.all([read("in_invoice"), read("in_refund")]);
      return { billCount: bills.count, billTotal: bills.total, creditCount: credits.count, creditTotal: Math.abs(credits.total) };
    },
    async shortages({ windowDays = 60, maxDaysLeft = 7, limit = 20, at = Date.now() } = {}) {
      const since = new Date(at - windowDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      // Both reads are paged: there are more distinct products sold in two
      // months, and more products holding stock, than one page can carry, and a
      // truncated page silently drops exactly the items nobody happened to see.
      const page = async (model: string, method: string, args: unknown[], extra: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
        const all: Array<Record<string, unknown>> = [];
        for (let offset = 0; offset < 40_000; offset += 2000) {
          const rows = (await execute(model, method, args, { ...extra, limit: 2000, offset })) as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(rows) || !rows.length) break;
          all.push(...rows);
          if (rows.length < 2000) break;
        }
        return all;
      };

      const soldRows = await page("pos.order.line", "read_group",
        [[["order_id.date_order", ">=", since], ["order_id.state", "in", ["paid", "done", "invoiced"]]], ["qty"], ["product_id"]],
        { lazy: false });
      const sold = new Map<number, number>();
      for (const row of soldRows) {
        const product = row.product_id;
        if (!Array.isArray(product) || typeof product[0] !== "number") continue;
        const qty = Number(row.qty);
        if (Number.isFinite(qty) && qty > 0) sold.set(product[0], (sold.get(product[0]) ?? 0) + qty);
      }

      const stockRows = await page("product.product", "search_read",
        [[["sale_ok", "=", true], ["active", "=", true], ["qty_available", ">", 0]], ["name", "qty_available"]],
        { order: "id asc" });

      const running: ShortageItem[] = [];
      for (const row of stockRows) {
        const movement = sold.get(Number(row.id));
        // Stock that never moves is not running out, however little of it there
        // is -- that is most of the long tail, and putting it on this list is
        // what made the old one unusable.
        if (!movement) continue;
        const qty = Number(row.qty_available);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const perDay = movement / windowDays;
        const daysLeft = qty / perDay;
        if (daysLeft > maxDaysLeft) continue;
        running.push({ name: String(row.name ?? "?"), qty, perDay, daysLeft });
      }
      return running.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, limit);
    },
    async activeProductCount() {
      const count = await execute("product.product", "search_count", [[["sale_ok", "=", true], ["active", "=", true]]]);
      return Number(count ?? 0);
    },
  };
}

export { formatAmount };
