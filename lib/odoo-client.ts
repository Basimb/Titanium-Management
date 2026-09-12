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

export type OdooSession = {
  salesSummary(sinceIso: string, untilIso: string): Promise<SalesSummary>;
  salesByLocation(sinceIso: string, untilIso: string): Promise<LocationSales[]>;
  purchaseSummary(sinceIso: string, untilIso: string): Promise<PurchaseSummary>;
  lowStock(thresholdQty: number, limit?: number): Promise<LowStockItem[]>;
  activeProductCount(): Promise<number>;
};

/** Authenticates once, then reuses that session for every read below. */
export async function openOdooSession(config: OdooConfig, fetcher: Fetcher = fetch): Promise<OdooSession> {
  assertConfig(config);
  const uid = await authenticate(config, fetcher);
  const execute = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
    call(config, "object", "execute_kw", [config.db, uid, config.apiKey, model, method, args, kwargs], fetcher);
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
    async activeProductCount() {
      const count = await execute("product.product", "search_count", [[["sale_ok", "=", true], ["active", "=", true]]]);
      return Number(count ?? 0);
    },
  };
}

export { formatAmount };
