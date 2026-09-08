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
  await session.lowStock(10);
  assert.equal(calls[0].service, "common");
  assert.equal(calls[1].args[3], "pos.order");
  assert.equal(calls[1].args[4], "read_group");
  assert.equal(calls[2].args[3], "product.product");
  assert.equal(calls[2].args[4], "search_read");
});

test("salesSummary reads the aggregated total and count from read_group", async () => {
  const fake = fetcher((url, body) => body.params.service === "common" ? { result: 1 } : { result: [{ amount_total: 1234.5, __count: 8 }] });
  const session = await openOdooSession(config, fake);
  const summary = await session.salesSummary("2026-09-01", "2026-09-02");
  assert.deepEqual(summary, { orderCount: 8, totalAmount: 1234.5 });
});

test("lowStock maps search_read rows and activeProductCount reads search_count", async () => {
  const fake = fetcher((url, body) => {
    if (body.params.service === "common") return { result: 1 };
    if (body.params.args[4] === "search_read") return { result: [{ name: "بنادول", qty_available: 3 }, { name: "أموكسيل", qty_available: 0 }] };
    return { result: 214 };
  });
  const session = await openOdooSession(config, fake);
  assert.deepEqual(await session.lowStock(10), [{ name: "بنادول", qty: 3 }, { name: "أموكسيل", qty: 0 }]);
  assert.equal(await session.activeProductCount(), 214);
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
