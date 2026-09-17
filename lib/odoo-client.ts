/**
 * Minimal, read-only client for the pharmacy's own Odoo instance (external
 * JSON-RPC API). Used only to read sales and inventory numbers for the
 * periodic report -- there is no create/write/unlink call anywhere in this
 * file, on purpose: a WhatsApp-triggered report must never be able to change
 * anything in the pharmacy's real business system.
 */

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
  if (typeof result !== "number" || result <= 0) throw new OdooError("odoo_authentication_failed");
  return result;
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

function formatAmount(value: number): string {
  const fixed = (Number.isFinite(value) ? value : 0).toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withSeparators}.${fraction}`;
}

export type SalesSummary = { orderCount: number; totalAmount: number };
export type LowStockItem = { name: string; qty: number };
export type LocationSales = { location: string; orderCount: number; totalAmount: number };
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
export type PayablesSummary = { billCount: number; billTotal: number };

export type OdooSession = {
  salesSummary(sinceIso: string, untilIso: string): Promise<SalesSummary>;
  salesByLocation(sinceIso: string, untilIso: string): Promise<LocationSales[]>;
  purchaseSummary(sinceIso: string, untilIso: string): Promise<PurchaseSummary>;
  lowStock(thresholdQty: number, limit?: number): Promise<LowStockItem[]>;
  activeProductCount(): Promise<number>;
  expirySummary(withinDays: number): Promise<ExpirySummary>;
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
  return {
    async salesSummary(sinceIso, untilIso) {
      const domain = [["date_order", ">=", sinceIso], ["date_order", "<", untilIso], ["state", "in", ["paid", "done", "invoiced"]]];
      const groups = (await execute("pos.order", "read_group", [domain, ["amount_total"], []])) as Array<Record<string, unknown>> | undefined;
      const row = Array.isArray(groups) ? groups[0] : undefined;
      return { orderCount: Number(row?.__count ?? 0), totalAmount: Number(row?.amount_total ?? 0) };
    },
    async salesByLocation(sinceIso, untilIso) {
      const domain = [["date_order", ">=", sinceIso], ["date_order", "<", untilIso], ["state", "in", ["paid", "done", "invoiced"]]];
      const groups = (await execute("pos.order", "read_group", [domain, ["amount_total"], ["location_id"]])) as Array<Record<string, unknown>> | undefined;
      return (Array.isArray(groups) ? groups : []).map(row => {
        const locationId = row.location_id;
        const location = Array.isArray(locationId) && typeof locationId[1] === "string" ? locationId[1] : "?";
        return { location, orderCount: Number(row.__count ?? 0), totalAmount: Number(row.amount_total ?? 0) };
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
        purchaseCount: Number(purchaseRow?.__count ?? 0), purchaseAmount: Number(purchaseRow?.amount_total ?? 0),
        returnCount: Number(returnRow?.__count ?? 0), returnAmount: Number(returnRow?.amount_total ?? 0),
      };
    },
    async lowStock(thresholdQty, limit = 20) {
      const domain = [["sale_ok", "=", true], ["active", "=", true], ["qty_available", "<=", thresholdQty]];
      const rows = (await execute("product.product", "search_read", [domain, ["name", "qty_available"]],
        { order: "qty_available asc", limit })) as Array<Record<string, unknown>> | undefined;
      return (Array.isArray(rows) ? rows : []).map(row => ({ name: String(row.name ?? "?"), qty: Number(row.qty_available ?? 0) }));
    },
    async expirySummary(withinDays) {
      // Odoo renamed stock.production.lot to stock.lot in 16.0; this instance
      // is 16.0 (verified against the live server), and the domain walks
      // lot_id.expiration_date rather than reading lots directly so that a lot
      // with no stock left simply does not appear.
      const day = 86_400_000;
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      const until = new Date(Date.now() + withinDays * day).toISOString().slice(0, 10);
      const internal: unknown[] = [["location_id.usage", "=", "internal"], ["quantity", ">", 0]];
      const read = async (extra: unknown[]) => {
        const groups = (await execute("stock.quant", "read_group", [[...internal, ...extra], ["quantity"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
        const row = Array.isArray(groups) ? groups[0] : undefined;
        return { lines: Number(row?.__count ?? 0), qty: Number(row?.quantity ?? 0) };
      };
      const [expired, soon] = await Promise.all([
        read([["lot_id.expiration_date", "<", today]]),
        read([["lot_id.expiration_date", ">=", today], ["lot_id.expiration_date", "<=", until]]),
      ]);
      return { expiredLines: expired.lines, expiredQty: expired.qty, soonLines: soon.lines, soonQty: soon.qty, withinDays };
    },
    async openPayables() {
      // Posted vendor bills that are still unpaid or only part-paid -- the same
      // move_type the purchases report already uses, narrowed by payment_state.
      const domain = [["move_type", "=", "in_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]];
      const groups = (await execute("account.move", "read_group", [domain, ["amount_residual"], []], { lazy: true })) as Array<Record<string, unknown>> | undefined;
      const row = Array.isArray(groups) ? groups[0] : undefined;
      return { billCount: Number(row?.__count ?? 0), billTotal: Number(row?.amount_residual ?? 0) };
    },
    async activeProductCount() {
      const count = await execute("product.product", "search_count", [[["sale_ok", "=", true], ["active", "=", true]]]);
      return Number(count ?? 0);
    },
  };
}

export { formatAmount };
