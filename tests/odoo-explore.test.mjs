// The open-question layer: the model composes a query over any table, and the
// numbers still come from Odoo. What these tests hold down is the boundary --
// a composed query that is not exactly the allowed shape must not run, and
// every answer must carry back what it counted.
import test from "node:test";
import assert from "node:assert/strict";
import { composeOdooQuery, formatOdooResult, exploreOdoo } from "../lib/odoo-explore.ts";
import { validateOdooQuery } from "../lib/odoo-query.ts";
import { forgetOdooCatalog } from "../lib/odoo-schema.ts";

test.beforeEach(() => forgetOdooCatalog());

const CATALOG = "pos.order (Orders): amount_total:monetary, date_order:datetime, state:char";
const AT = Date.UTC(2026, 8, 17, 9, 0);

const replying = content => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const options = (content, extra = {}) => ({ apiKey: "synthetic-key-never-real", fetcher: replying(content), now: AT, ...extra });

test("a composed query that fits the shape is allowed through", async () => {
  const query = await composeOdooQuery("كم بعنا اليوم", CATALOG, options(JSON.stringify({
    model: "pos.order", method: "read_group", domain: [["state", "in", ["paid", "done"]]], fields: ["amount_total"], groupBy: [],
  })));
  assert.equal(query.model, "pos.order");
  assert.equal(query.limit, 50);
});

test("a composed query that does not fit is refused, not repaired", async () => {
  for (const content of [
    JSON.stringify({ model: "pos.order", method: "write", domain: [], fields: ["amount_total"] }),
    JSON.stringify({ model: "pos.order", method: "read_group", domain: [["state", "=~", "paid"]], fields: ["amount_total"] }),
    JSON.stringify({ model: "pos order", method: "search_count", domain: [] }),
    JSON.stringify({ none: true }),
    "SELECT sum(amount_total) FROM pos_order",
    "{",
  ]) {
    assert.equal(await composeOdooQuery("سؤال", CATALOG, options(content)), null, content.slice(0, 40));
  }
});

test("with no key, no catalog, or a question too long to be one, nothing is sent", async () => {
  let calls = 0;
  const counting = extra => ({ fetcher: async () => { calls += 1; return { ok: true, json: async () => ({}) }; }, ...extra });
  assert.equal(await composeOdooQuery("س", CATALOG, counting({})), null);
  assert.equal(await composeOdooQuery("س", "", counting({ apiKey: "k" })), null);
  assert.equal(await composeOdooQuery("س".repeat(301), CATALOG, counting({ apiKey: "k" })), null);
  assert.equal(calls, 0);
});

test("a provider that errors or hangs composes nothing instead of throwing", async () => {
  assert.equal(await composeOdooQuery("س", CATALOG, { apiKey: "k", fetcher: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await composeOdooQuery("س", CATALOG, { apiKey: "k", fetcher: async () => { throw new Error("down"); } }), null);
});

test("the question is the only thing sent, and the local date is stated for it", async () => {
  let body;
  await composeOdooQuery("مبيعات اليوم", CATALOG, {
    apiKey: "synthetic-key-never-real", now: AT,
    fetcher: async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
  });
  assert.equal(body.messages[1].content, "مبيعات اليوم");
  assert.match(body.messages[0].content, /2026-09-17/);
  assert.match(body.messages[0].content, /pos\.order \(Orders\)/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-key-never-real/);
});

test("a count reads as a count, and an empty result says so rather than showing a zero", () => {
  const count = validateOdooQuery({ model: "pos.order", method: "search_count", domain: [] });
  assert.match(formatOdooResult(count, 1234), /1,234/);
  const listing = validateOdooQuery({ model: "pos.order", method: "search_read", domain: [], fields: ["name"] });
  assert.match(formatOdooResult(listing, []), /ما في ولا سجل/);
});

test("a breakdown names each group and its total, and says when it was cut short", () => {
  const grouped = validateOdooQuery({ model: "pos.order", method: "read_group", domain: [], fields: ["amount_total"], groupBy: ["location_id"] });
  const rows = Array.from({ length: 18 }, (unused, index) => ({ location_id: [index + 1, `FRV${index}/Stock`], amount_total: 100 + index, __count: 3 }));
  const text = formatOdooResult(grouped, rows, "دينار");
  assert.match(text, /• FRV0\/Stock — 100\.00 دينار \(3 سجل\)/);
  assert.match(text, /… و3 أكثر/, "a long breakdown is trimmed and says so");
});

test("a listing shows the fields that were asked for, and relations read as their names", () => {
  const listing = validateOdooQuery({ model: "product.product", method: "search_read", domain: [], fields: ["name", "qty_available", "categ_id"] });
  const text = formatOdooResult(listing, [{ name: "بنادول", qty_available: 4, categ_id: [7, "أدوية"] }]);
  assert.match(text, /• بنادول — 4\.00 — أدوية/);
});

test("an answer carries back the table and the filter it used", async () => {
  const session = {
    async runQuery(query) {
      if (query.model === "ir.model") return [{ model: "pos.order", name: "Orders" }];
      if (query.model === "ir.model.fields") return [{ model: "pos.order", name: "amount_total", ttype: "monetary", field_description: "Total" }];
      return 42;
    },
  };
  const reply = await exploreOdoo("كم عملية صارت", {
    session, cacheKey: "basim", apiKey: "k", now: AT,
    fetcher: replying(JSON.stringify({ model: "pos.order", method: "search_count", domain: [["state", "=", "paid"]] })),
  });
  assert.match(reply, /🔢 \*42\*/);
  assert.match(reply, /📋 الجدول: pos\.order/);
  assert.match(reply, /state = paid/);
});

test("when no safe query can be composed, the message is simply not ours", async () => {
  const session = {
    async runQuery(query) {
      if (query.model === "ir.model") return [{ model: "pos.order", name: "Orders" }];
      if (query.model === "ir.model.fields") return [{ model: "pos.order", name: "amount_total", ttype: "monetary", field_description: "Total" }];
      return assert.fail("nothing should run");
    },
  };
  assert.equal(await exploreOdoo("مين بدي أوظف؟", { session, cacheKey: "b", apiKey: "k", fetcher: replying('{"none":true}') }), null);
});

test("an unreachable pharmacy system is not an answer either", async () => {
  const session = { async runQuery() { throw new Error("odoo_unreachable"); } };
  assert.equal(await exploreOdoo("كم بعنا", { session, cacheKey: "b", apiKey: "k", fetcher: replying("{}") }), null);
});
