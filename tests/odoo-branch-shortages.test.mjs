// Basim, 2026-09-20, after the company-wide shortage list came back with
// sixteen items: "ليش ما بيكمل عن ال 16؟" -- and then, once both reasons were
// on the table, "شيل حد ال 15 وارسل كل النواقص لكل فرع برساله لحال".
//
// Two faults, not one. The reckoning added every branch's stock together, so
// an item at zero in Dabouq read as "in stock" because Naoor held a shelf of
// it; and whatever survived that was cut to fifteen items by a hard limit,
// silently. Branch by branch and uncapped, the same morning had 46 items.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOdooSession, forgetOdooSessions } from "../lib/odoo-client.ts";
import { createOdooReportJobs } from "../lib/odoo-reports.ts";

test.beforeEach(() => { forgetOdooSessions(); });
const odoo = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@x.com", apiKey: "k" };

// branches: { CODE: { locationId, configIds, stock: {productId: qty}, sold: {productId: qty} } }
// products: { productId: [name, barcode, cost] }
function pharmacy(branches, products) {
  const byLocation = new Map(Object.values(branches).map(branch => [branch.locationId, branch]));
  const byConfig = new Map(Object.values(branches).flatMap(branch => branch.configIds.map(id => [id, branch])));
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
    const [, , , model, method, args, kwargs] = body.params.args;
    const domain = args[0];
    const leaf = field => domain.find(clause => Array.isArray(clause) && clause[0] === field);
    let result = [];
    if (!(kwargs.offset || 0)) {
      if (model === "pos.config") {
        result = Object.values(branches).flatMap(branch => branch.configIds.map(id => ({ id, picking_type_id: [id * 10, "PoS Orders"] })));
      } else if (model === "stock.picking.type") {
        result = Object.entries(branches).flatMap(([code, branch]) =>
          branch.configIds.map(id => ({ id: id * 10, default_location_src_id: [branch.locationId, `${code}/Stock`] })));
      } else if (model === "stock.quant") {
        const branch = byLocation.get(leaf("location_id")?.[2]);
        result = Object.entries(branch?.stock ?? {}).map(([id, quantity]) => ({ product_id: [Number(id), products[id][0]], quantity, __count: 1 }));
      } else if (model === "pos.order.line") {
        const branch = byConfig.get(leaf("order_id.config_id")?.[2]?.[0]);
        result = Object.entries(branch?.sold ?? {}).map(([id, qty]) => ({ product_id: [Number(id), products[id][0]], qty, __count: 1 }));
      } else if (model === "product.product") {
        result = Object.entries(products).map(([id, [name, barcode, cost]]) => ({ id: Number(id), name, barcode, standard_price: cost }));
      }
    }
    return { ok: true, json: async () => ({ result }) };
  };
}

// One medicine. Naoor has a shelf of it; Dabouq sells it and has none left.
const TWO_BRANCHES = {
  NAOOR: { locationId: 8, configIds: [1], stock: { 1: 400 }, sold: { 1: 60 } },
  DABOQ: { locationId: 36, configIds: [2], stock: { 1: 0 }, sold: { 1: 60 } },
};
const PRODUCTS = { 1: ["GLUCOPHAGE 1000 MG", "600111", 2] };

test("a branch that has run out is not covered up by a branch that has not", async () => {
  const session = await openOdooSession(odoo, pharmacy(TWO_BRANCHES, PRODUCTS));
  const branches = await session.branchShortages({ windowDays: 60, maxDaysLeft: 7 });
  assert.deepEqual(branches.map(branch => branch.code), ["DABOQ"]);
  assert.equal(branches[0].items.length, 1);
  assert.equal(branches[0].items[0].packs, 0, "nothing on that shelf");
  // The company-wide reckoning, on the very same data, sees 400 in stock.
  assert.deepEqual(await session.shortages({ windowDays: 60, maxDaysLeft: 7 }), []);
});

test("each branch is measured against its own sales, not the company's", async () => {
  // Same two packs on both shelves; Naoor sells sixty times as fast.
  const session = await openOdooSession(odoo, pharmacy({
    NAOOR: { locationId: 8, configIds: [1], stock: { 1: 2 }, sold: { 1: 600 } },
    SAFOT: { locationId: 20, configIds: [3], stock: { 1: 2 }, sold: { 1: 10 } },
  }, PRODUCTS));
  const branches = await session.branchShortages({ windowDays: 60, maxDaysLeft: 7 });
  assert.deepEqual(branches.map(branch => branch.code), ["NAOOR"], "twelve days of cover at Safoot is not a shortage");
});

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY);");
  return db;
}
const AT = Date.UTC(1970, 0, 2, 9, 0, 0); // 09:00, the shortages slot, at offset 0

const jobsFor = (db, branches, products, at = AT) => createOdooReportJobs({
  db, now: () => at,
  config: { enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us",
    timezoneOffsetMinutes: 0, fetcher: pharmacy(branches, products) },
});

test("every branch gets its own message, and none of them repeats the same day", async t => {
  const db = fixture(t);
  const branches = {
    NAOOR: { locationId: 8, configIds: [1], stock: { 1: 1 }, sold: { 1: 600 } },
    DABOQ: { locationId: 36, configIds: [2], stock: { 1: 0 }, sold: { 1: 60 } },
  };
  const jobs = jobsFor(db, branches, PRODUCTS);
  const sent = [];
  for (let i = 0; i < 4; i += 1) await jobs.deliverNext(async message => { sent.push(message.text); return {}; });
  assert.equal(sent.length, 2, "one message per branch, and then nothing more");
  assert.ok(sent.some(text => text.includes("نواقص فرع الناعور")), sent.join("\n--\n"));
  assert.ok(sent.some(text => text.includes("نواقص فرع دابوق")), sent.join("\n--\n"));
  for (const text of sent) {
    assert.match(text, /المتوفر: \*/, "the quantity is packs under a fixed label");
    assert.doesNotMatch(text, /قطعة|تجزئة/, "pieces never reach the message");
  }
  assert.match(sent.find(text => text.includes("دابوق")), /المتوفر: \*صفر\*/);
});

test("nothing is cut at fifteen: a branch with more than that sends all of them", async t => {
  const db = fixture(t);
  const products = {};
  const stock = {}, sold = {};
  for (let id = 1; id <= 22; id += 1) { products[id] = [`MEDICINE ${id}`, `60000${id}`, 1]; stock[id] = 1; sold[id] = 600; }
  const jobs = jobsFor(db, { NAOOR: { locationId: 8, configIds: [1], stock, sold } }, products);
  let text = "";
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  for (let id = 1; id <= 22; id += 1) assert.ok(text.includes(`MEDICINE ${id}`), `MEDICINE ${id} was dropped`);
  assert.match(text, /المجموع: 22 صنف/);
});

test("a branch too long for one message is split, never truncated", async t => {
  const db = fixture(t);
  const products = {};
  const stock = {}, sold = {};
  for (let id = 1; id <= 95; id += 1) { products[id] = [`MEDICINE ${id}`, `60000${id}`, 1]; stock[id] = 1; sold[id] = 600; }
  const jobs = jobsFor(db, { NAOOR: { locationId: 8, configIds: [1], stock, sold } }, products);
  const sent = [];
  for (let i = 0; i < 5; i += 1) await jobs.deliverNext(async message => { sent.push(message.text); return {}; });
  assert.equal(sent.length, 3, "40 + 40 + 15");
  assert.match(sent[0], /\(1\/3\)/);
  const all = sent.join("\n");
  for (let id = 1; id <= 95; id += 1) assert.ok(all.includes(`MEDICINE ${id}`), `MEDICINE ${id} was dropped`);
  assert.match(sent[2], /المجموع: 95 صنف/);
});

test("when no branch is about to run out, one line says so and no branch message goes out", async t => {
  const db = fixture(t);
  const jobs = jobsFor(db, { NAOOR: { locationId: 8, configIds: [1], stock: { 1: 4000 }, sold: { 1: 60 } } }, PRODUCTS);
  const sent = [];
  for (let i = 0; i < 3; i += 1) await jobs.deliverNext(async message => { sent.push(message.text); return {}; });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ما في صنف متحرّك/);
});

// The bridge drains its queues once a second. Four branch messages leave over
// four ticks, and every tick in between asks the planner what is pending --
// so the catalogue must be read once for the batch, not once per tick.
test("the pharmacy's catalogue is read once for the batch, not once a second", async t => {
  const db = fixture(t);
  const branches = {
    NAOOR: { locationId: 8, configIds: [1], stock: { 1: 1 }, sold: { 1: 600 } },
    DABOQ: { locationId: 36, configIds: [2], stock: { 1: 0 }, sold: { 1: 60 } },
  };
  let scans = 0;
  const underlying = pharmacy(branches, PRODUCTS);
  const jobs = createOdooReportJobs({
    db, now: () => AT,
    config: { enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us", timezoneOffsetMinutes: 0,
      fetcher: async (url, options) => {
        if (JSON.parse(options.body).params.args?.[3] === "stock.quant") scans += 1;
        return underlying(url, options);
      } },
  });
  for (let i = 0; i < 8; i += 1) await jobs.deliverNext(async () => ({}));
  assert.equal(scans, 2, "two branches, read once each, however many times the queue is drained");
});
