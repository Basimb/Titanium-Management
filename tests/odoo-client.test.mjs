import test from "node:test";
import assert from "node:assert/strict";
import { openOdooSession, OdooError, formatAmount } from "../lib/odoo-client.ts";

const config = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@pharmacy.example.com", apiKey: "secret-key" };

function fetcher(handler) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => handler(url, body) };
  };
}

test("openOdooSession authenticates once and reuses the uid for every read", async () => {
  const calls = [];
  const fake = fetcher((url, body) => {
    calls.push(body.params);
    assert.equal(url, "https://pharmacy.example.com/jsonrpc");
    if (body.params.service === "common") { assert.deepEqual(body.params.args.slice(0, 3), ["pharmacy", "bot@pharmacy.example.com", "secret-key"]); return { result: 7 }; }
    assert.equal(body.params.args[0], "pharmacy"); assert.equal(body.params.args[1], 7); assert.equal(body.params.args[2], "secret-key");
    return { result: [] };
  });
  const session = await openOdooSession(config, fake);
  await session.salesSummary("2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
  await session.activeProductCount();
  assert.equal(calls[0].service, "common");
  assert.equal(calls[1].args[3], "pos.order");
  assert.equal(calls[1].args[4], "read_group");
  const products = calls.find(entry => entry.args[3] === "product.product");
  assert.equal(products.args[4], "search_count");
  assert.equal(calls.filter(entry => entry.service === "common").length, 1, "one login for all of it");
});

test("salesSummary nets refunds out of the total but counts them apart", async () => {
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    const domain = body.params.args[5][0];
    const sign = domain.find(leaf => Array.isArray(leaf) && leaf[0] === "amount_total");
    assert.ok(sign, "each read narrows to one side of zero");
    return { result: sign[1] === "<" ? [{ amount_total: -100, __count: 2 }] : [{ amount_total: 1234.5, __count: 8 }] };
  });
  const session = await openOdooSession(config, fake);
  assert.deepEqual(await session.salesSummary("2026-09-01", "2026-09-02"),
    { orderCount: 8, totalAmount: 1134.5, refundCount: 2, refundAmount: 100 });
});

// Insurance, corporate accounts and the clinics bill rather than ring up, and
// every sales figure here used to miss them completely.
test("invoiceSales reads posted customer invoices by plain date", async () => {
  let domain;
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    assert.equal(body.params.args[3], "account.move");
    domain = body.params.args[5][0];
    return { result: [{ amount_total: 900, __count: 3 }] };
  });
  const session = await openOdooSession(config, fake);
  assert.deepEqual(await session.invoiceSales("2026-09-01T21:00:00.000Z", "2026-09-08T21:00:00.000Z"),
    { invoiceCount: 3, totalAmount: 900 });
  assert.deepEqual(domain.find(leaf => leaf[0] === "move_type"), ["move_type", "=", "out_invoice"]);
  assert.deepEqual(domain.find(leaf => leaf[0] === "state"), ["state", "=", "posted"]);
  assert.deepEqual(domain.filter(leaf => leaf[0] === "invoice_date"),
    [["invoice_date", ">=", "2026-09-01"], ["invoice_date", "<", "2026-09-08"]]);
});

test("salesByLocation reads per-location totals and counts from a location_id-grouped read_group", async () => {
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    assert.equal(body.params.args[4], "read_group");
    assert.deepEqual(body.params.args[5][2], ["location_id"]);
    return { result: [
      { location_id: [12, "NAOOR/Stock"], amount_total: 1863.71, __count: 177 },
      { location_id: [7, "SAFOT/Stock"], amount_total: 467.9, __count: 58 },
    ] };
  });
  const session = await openOdooSession(config, fake);
  assert.deepEqual(await session.salesByLocation("2026-09-11T00:00:00.000Z", "2026-09-12T00:00:00.000Z"), [
    { location: "NAOOR/Stock", orderCount: 177, totalAmount: 1863.71 },
    { location: "SAFOT/Stock", orderCount: 58, totalAmount: 467.9 },
  ]);
});

test("purchaseSummary reads posted vendor bills (in_invoice) and vendor credit notes (in_refund) separately, by plain date", async () => {
  const calls = [];
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    calls.push(body.params.args[5][0]);
    return body.params.args[5][0].some(clause => clause[0] === "move_type" && clause[2] === "in_refund")
      ? { result: [{ amount_total: 150, __count: 2 }] }
      : { result: [{ amount_total: 900, __count: 5 }] };
  });
  const session = await openOdooSession(config, fake);
  const summary = await session.purchaseSummary("2026-09-01T00:00:00.000Z", "2026-09-12T18:30:00.000Z");
  assert.deepEqual(summary, { purchaseCount: 5, purchaseAmount: 900, returnCount: 2, returnAmount: 150 });
  for (const domain of calls) {
    assert.equal(domain.find(clause => clause[0] === "state")[2], "posted");
    assert.deepEqual(domain.find(clause => clause[0] === "invoice_date" && clause[1] === ">="), ["invoice_date", ">=", "2026-09-01"]);
    assert.deepEqual(domain.find(clause => clause[0] === "invoice_date" && clause[1] === "<="), ["invoice_date", "<=", "2026-09-12"]);
  }
});

test("a failed authentication never reaches a real data call", async () => {
  const fake = fetcher(() => ({ result: 0 }));
  await assert.rejects(() => openOdooSession(config, fake), OdooError);
});

test("network failure and RPC error both surface as OdooError, never raw provider text", async () => {
  await assert.rejects(() => openOdooSession(config, async () => { throw new Error("ECONNRESET"); }), OdooError);
  await assert.rejects(() => openOdooSession(config, fetcher(() => ({ error: { message: "Access Denied" } }))), OdooError);
});

test("a non-https URL or missing credential is rejected before any network call", async () => {
  let called = false;
  const fake = async () => { called = true; return { ok: true, json: async () => ({ result: 1 }) }; };
  await assert.rejects(() => openOdooSession({ ...config, url: "http://pharmacy.example.com" }, fake), OdooError);
  await assert.rejects(() => openOdooSession({ ...config, apiKey: "" }, fake), OdooError);
  assert.equal(called, false);
});

test("formatAmount adds thousands separators and two decimals", () => {
  assert.equal(formatAmount(1234.5), "1,234.50");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(1000000), "1,000,000.00");
});

// Measured on the live catalogue, 2026-09-17: 60,452 saleable products, only
// 13,540 holding any stock, and 10,896 of THOSE at ten units or fewer -- a
// pharmacy carries one or two of most things by design. So a unit threshold
// cannot separate "running out" from "normal", and days of cover is what does.
test("shortages rank by how long the stock lasts, not by how little of it there is", async () => {
  const shelf = [
    { id: 1, name: "بنادول", qty_available: 2 },        // 10/day  -> 0.2 days
    { id: 2, name: "كريم نادر", qty_available: 2 },      // 0.05/day -> 40 days
    { id: 3, name: "صنف راكد", qty_available: 1 },       // never sold
    { id: 4, name: "شامبو", qty_available: 120 },        // 30/day  -> 4 days
  ];
  const sold = [
    { product_id: [1, "بنادول"], qty: 600 },
    { product_id: [2, "كريم نادر"], qty: 3 },
    { product_id: [4, "شامبو"], qty: 1800 },
  ];
  const seen = [];
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    const [, , , model, method, args, kwargs] = body.params.args;
    seen.push({ model, method, offset: kwargs.offset, domain: args[0] });
    if (kwargs.offset) return { result: [] };
    return { result: model === "pos.order.line" ? sold : shelf };
  });
  const session = await openOdooSession(config, fake);
  const running = await session.shortages({ windowDays: 60, maxDaysLeft: 7, at: Date.UTC(2026, 8, 17) });
  assert.deepEqual(running.map(item => item.name), ["بنادول", "شامبو"]);
  assert.equal(Math.round(running[0].daysLeft * 10) / 10, 0.2);
  assert.equal(Math.round(running[1].daysLeft), 4);
  // Only stock that exists is even looked at -- the catalogue is not the shelf.
  const stock = seen.find(entry => entry.model === "product.product");
  assert.ok(stock.domain.some(leaf => leaf[0] === "qty_available" && leaf[1] === ">" && leaf[2] === 0));
});

test("both reads are paged, so a long tail is never silently cut off", async () => {
  const page = Array.from({ length: 2000 }, (unused, index) => ({ id: index + 1, name: `p${index}`, qty_available: 1 }));
  const offsets = [];
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    const [, , , model, , , kwargs] = body.params.args;
    offsets.push(`${model}@${kwargs.offset ?? 0}`);
    if (model === "pos.order.line") return { result: kwargs.offset ? [] : [{ product_id: [1, "p0"], qty: 600 }] };
    return { result: kwargs.offset === 0 ? page : kwargs.offset === 2000 ? page.slice(0, 5) : [] };
  });
  const session = await openOdooSession(config, fake);
  await session.shortages({ at: Date.UTC(2026, 8, 17) });
  assert.ok(offsets.includes("product.product@2000"), `a full page must be followed by the next: ${offsets.join(",")}`);
});
