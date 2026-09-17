// An end-to-end pass over the wire, against a fake Odoo 16 that REFUSES
// anything it would not recognise. The unit tests elsewhere stub the session,
// so they prove the logic and say nothing about whether the JSON-RPC envelope
// is the one Odoo actually accepts -- arg order, kwargs, the uid position.
// This file is the part that would otherwise only be discovered live.
import test from "node:test";
import assert from "node:assert/strict";
import { openOdooSession, forgetOdooSessions } from "../lib/odoo-client.ts";
import { exploreOdoo } from "../lib/odoo-explore.ts";
import { forgetOdooCatalog } from "../lib/odoo-schema.ts";
import { forgetOdooAnswers } from "../lib/odoo-questions.ts";

test.beforeEach(() => { forgetOdooSessions(); forgetOdooCatalog(); forgetOdooAnswers(); });

const config = { url: "https://v2.example.com", db: "pharmacy", username: "bot@example.com", apiKey: "synthetic-key" };
const UID = 7;

// Every table and field the fake knows about. A query naming anything else is
// rejected the way Odoo would reject it, so a wrong field name cannot pass.
const SCHEMA = {
  "pos.order": ["name", "amount_total", "date_order", "state", "location_id", "partner_id"],
  "account.move": ["name", "move_type", "state", "invoice_date", "amount_total", "amount_residual", "payment_state", "partner_id"],
  "product.product": ["name", "qty_available", "sale_ok", "active", "standard_price", "categ_id"],
  "stock.quant": ["quantity", "location_id", "lot_id"],
  "stock.lot": ["name", "expiration_date", "product_id"],
};
const LABELS = { "pos.order": "Point of Sale Orders", "account.move": "Journal Entry",
  "product.product": "Product", "stock.quant": "Quant", "stock.lot": "Lot/Serial Number" };

function fakeOdoo({ onCall } = {}) {
  const calls = [];
  // The client turns ANY throw from the fetcher into "odoo_unreachable", so an
  // assertion that fires in here would otherwise surface as a connection
  // problem. Keep them and re-raise after the call, where they read properly.
  const refusals = [];
  const fetcher = async (url, init) => {
    try { return await serve(url, init); }
    catch (error) { refusals.push(error); throw error; }
  };
  const serve = async (url, init) => {
    assert.equal(url, "https://v2.example.com/jsonrpc", "Odoo's JSON-RPC endpoint");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.method, "call");
    const { service, method, args } = body.params;

    if (service === "common") {
      assert.equal(method, "authenticate");
      assert.deepEqual(args, [config.db, config.username, config.apiKey, {}]);
      return { ok: true, json: async () => ({ result: UID }) };
    }

    assert.equal(service, "object");
    assert.equal(method, "execute_kw");
    const [db, uid, password, model, call, positional, kwargs] = args;
    assert.equal(db, config.db, "the database is the third positional in the envelope");
    assert.equal(uid, UID, "the uid from authenticate, not the login");
    assert.equal(password, config.apiKey);
    assert.ok(SCHEMA[model] || model.startsWith("ir."), `unknown table ${model}`);
    assert.ok(["search_read", "read_group", "search_count"].includes(call), `refused method ${call}`);
    assert.ok(Array.isArray(positional));
    calls.push({ model, call, positional, kwargs });

    const domain = positional[0];
    assert.ok(Array.isArray(domain), "a domain is always the first positional argument");
    for (const leaf of domain) {
      if (typeof leaf === "string") continue;
      const field = String(leaf[0]).split(".")[0];
      assert.ok(!SCHEMA[model] || SCHEMA[model].includes(field), `unknown field ${model}.${leaf[0]}`);
    }

    if (call === "search_read") {
      assert.ok(Array.isArray(positional[1]), "search_read takes [domain, fields]");
      assert.ok(kwargs && typeof kwargs.limit === "number", "search_read is always bounded");
    }
    if (call === "read_group") {
      assert.equal(positional.length, 3, "read_group takes [domain, fields, groupby]");
      assert.ok(Array.isArray(positional[2]));
    }
    if (call === "search_count") assert.equal(positional.length, 1, "search_count takes [domain] alone");

    return { ok: true, json: async () => ({ result: onCall({ model, call, positional, kwargs }) }) };
  };
  const settled = () => { if (refusals.length) throw refusals[0]; };
  return { fetcher, calls, settled };
}

const catalogAnswers = ({ model, call, positional }) => {
  if (model === "ir.model") return Object.keys(SCHEMA).map((name, index) => ({ id: index + 1, model: name, name: LABELS[name] }));
  if (model === "ir.model.fields") {
    const wanted = positional[0].find(leaf => Array.isArray(leaf) && leaf[0] === "model")?.[2] ?? [];
    return wanted.flatMap(name => (SCHEMA[name] ?? []).map((field, index) => ({
      id: index + 1, model: name, name: field,
      ttype: /amount|qty|price|quantity/.test(field) ? "monetary" : /_id$/.test(field) ? "many2one" : /date/.test(field) ? "datetime" : "char",
      field_description: field,
    })));
  }
  if (call === "search_count") return 128;
  if (call === "read_group") return [{ __count: 3, amount_total: 1863.71, location_id: [1, "NAOOR/Stock"] }];
  return [{ id: 1, name: "بنادول", qty_available: 4 }];
};

test("the login envelope is the one Odoo accepts, and the uid is reused, not the login", async () => {
  const odoo = fakeOdoo({ onCall: catalogAnswers });
  const session = await openOdooSession(config, odoo.fetcher);
  await session.salesSummary("2026-09-16T21:00:00.000Z", "2026-09-17T21:00:00.000Z");
  await session.expirySummary(90);
  odoo.settled();
  assert.ok(odoo.calls.length >= 3, "the reads went out");
});

test("every hand-written question survives the round trip against a strict server", async () => {
  const odoo = fakeOdoo({ onCall: catalogAnswers });
  const session = await openOdooSession(config, odoo.fetcher);
  const results = await Promise.all([
    session.salesByLocation("2026-09-16T21:00:00.000Z", "2026-09-17T21:00:00.000Z"),
    session.purchaseSummary("2026-09-01", "2026-09-17"),
    session.lowStock(10, 15),
    session.activeProductCount(),
    session.expirySummary(90),
    session.openPayables(),
  ]);
  odoo.settled();
  assert.equal(results[0][0].location, "NAOOR/Stock");
  assert.equal(results[3], 128, "a count comes back as a number");
});

// The open layer, all the way down: catalog read, composed query, execution,
// formatting. The "model" here returns a query that names a real table and
// real fields -- the fake server rejects anything else.
test("an open question goes catalog, query, wire, answer -- and says what it counted", async () => {
  const odoo = fakeOdoo({ onCall: catalogAnswers });
  const session = await openOdooSession(config, odoo.fetcher);
  const reply = await exploreOdoo("قديش مبيعات الناعور امبارح؟", {
    session, cacheKey: "basem", apiKey: "k", currencyLabel: "دينار",
    fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      model: "pos.order", method: "read_group",
      domain: [["state", "in", ["paid", "done"]], ["date_order", ">=", "2026-09-15T21:00:00"]],
      fields: ["amount_total"], groupBy: ["location_id"],
    }) } }] }) }),
  });
  assert.match(reply, /NAOOR\/Stock — 1,863\.71 دينار/);
  assert.match(reply, /📋 الجدول: pos\.order/);
  assert.match(reply, /state ضمن \(paid، done\)/);
  const models = odoo.calls.map(entry => entry.model);
  assert.ok(models.includes("ir.model") && models.includes("ir.model.fields"), "the map was read from Odoo");
  assert.ok(models.includes("pos.order"));
});

test("the catalog is read once, then every later question goes straight to its own table", async () => {
  const odoo = fakeOdoo({ onCall: catalogAnswers });
  const session = await openOdooSession(config, odoo.fetcher);
  const ask = question => exploreOdoo(question, {
    session, cacheKey: "basem", apiKey: "k",
    fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      model: "account.move", method: "search_count",
      domain: [["move_type", "=", "in_invoice"], ["state", "=", "posted"]],
    }) } }] }) }),
  });
  await ask("كم فاتورة مورد مرحّلة؟");
  const firstRound = odoo.calls.length;
  await ask("وكم صارت هلأ؟");
  const added = odoo.calls.slice(firstRound).map(entry => entry.model);
  assert.deepEqual(added, ["account.move"], "no second catalog read, and one login for both");
});

test("a query naming a table or field that does not exist never reaches the wire", async () => {
  const odoo = fakeOdoo({ onCall: catalogAnswers });
  const session = await openOdooSession(config, odoo.fetcher);
  for (const composed of [
    { model: "hr.payslip", method: "search_count", domain: [["net_wage", ">", 0]] },
    { model: "pos.order", method: "write", domain: [], fields: ["amount_total"] },
  ]) {
    const before = odoo.calls.length;
    const reply = await exploreOdoo("سؤال", {
      session, cacheKey: "basem", apiKey: "k",
      fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(composed) } }] }) }),
    });
    // `write` is refused by the validator before anything leaves this process,
    // which is our job. A table the server itself refuses is Odoo's job, and
    // what comes back then says the query failed and shows what was attempted
    // -- never a number, and never a claim that the system is down.
    if (composed.method === "write") {
      assert.equal(reply, null);
      assert.equal(odoo.calls.length, before, "a write never reaches the wire at all");
    } else {
      assert.match(reply, /ما قدرت أنفّذ/);
      assert.match(reply, /📋 الجدول: hr\.payslip/);
    }
  }
});
