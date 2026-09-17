// The catalog is what lets the model name a table it was never told about --
// so it has to come from Odoo, reflect what THIS person may see, and still fit
// in a prompt. These tests pin all three.
import test from "node:test";
import assert from "node:assert/strict";
import { odooCatalog, odooFields, pickModels, promptCatalog, forgetOdooCatalog } from "../lib/odoo-schema.ts";

test.beforeEach(() => forgetOdooCatalog());

const MODELS = [
  { model: "pos.order", name: "Point of Sale Orders" },
  { model: "stock.lot", name: "Lot/Serial Number" },
  { model: "hr.payslip", name: "Payslip" },
  { model: "ir.cron", name: "Scheduled Actions" },
  { model: "mail.message", name: "Message" },
];
const FIELDS = [
  { model: "pos.order", name: "amount_total", ttype: "monetary", field_description: "Total" },
  { model: "pos.order", name: "date_order", ttype: "datetime", field_description: "Date" },
  { model: "stock.lot", name: "expiration_date", ttype: "datetime", field_description: "Expiration Date" },
  { model: "hr.payslip", name: "net_wage", ttype: "monetary", field_description: "Net Wage" },
];

function sessionFor({ models = MODELS, fields = FIELDS } = {}) {
  const asked = [];
  return {
    asked,
    session: {
      async runQuery(query) {
        asked.push(query.model);
        if (query.model === "ir.model") return models;
        const wanted = query.domain.find(leaf => Array.isArray(leaf) && leaf[0] === "model")?.[2] ?? [];
        return fields.filter(row => wanted.includes(row.model));
      },
    },
  };
}

test("the map comes from Odoo, not from a list written down here", async () => {
  const { session, asked } = sessionFor();
  const catalog = await odooCatalog(session, "k1");
  assert.deepEqual(asked, ["ir.model"]);
  assert.ok(catalog.some(info => info.model === "pos.order" && info.label === "Point of Sale Orders"));
});

test("Odoo's own plumbing is left out -- it is noise in a prompt, not a secret", async () => {
  const catalog = await odooCatalog(sessionFor().session, "k2");
  const named = catalog.map(info => info.model);
  assert.ok(!named.includes("ir.cron"));
  assert.ok(!named.includes("mail.message"));
});

// Basim (2026-09-17): "ولا إشي — كل الجداول مفتوحة"، "كل واحد حسب صلاحيته".
// Payroll is in HIS map because he can see payroll. Somebody who cannot gets a
// shorter map from the same code -- the filtering is Odoo's, not this file's.
test("business tables are listed, payroll included -- access is Odoo's decision", async () => {
  const catalog = await odooCatalog(sessionFor().session, "k3");
  assert.ok(catalog.some(info => info.model === "hr.payslip"));
});

test("two people never share a map", async () => {
  await odooCatalog(sessionFor().session, "basim");
  const other = sessionFor({ models: [{ model: "pos.order", name: "Orders" }] });
  const theirs = await odooCatalog(other.session, "khaled");
  assert.deepEqual(theirs.map(info => info.model), ["pos.order"]);
  assert.equal(other.asked.length, 1, "a second person's map is fetched, never inherited");
});

test("the map is fetched once, and again only once it is old enough to have drifted", async () => {
  const one = sessionFor();
  await odooCatalog(one.session, "same", 1_000);
  await odooCatalog(one.session, "same", 2_000);
  assert.equal(one.asked.length, 1);
  await odooCatalog(one.session, "same", 1_000 + 7 * 60 * 60_000);
  assert.equal(one.asked.length, 2);
});

test("fields are fetched for the tables a question is about, not for the whole database", async () => {
  const one = sessionFor();
  const first = await odooFields(one.session, "k4", ["pos.order", "stock.lot"]);
  assert.deepEqual(first.get("stock.lot").map(field => field.name), ["expiration_date"]);
  assert.equal(one.asked.length, 1, "both tables in one round trip");
  await odooFields(one.session, "k4", ["pos.order"]);
  assert.equal(one.asked.length, 1, "a table already known is not fetched again");
  await odooFields(one.session, "k4", ["hr.payslip"]);
  assert.equal(one.asked.length, 2, "a new one is");
});

test("a table the person cannot see comes back empty rather than as an error", async () => {
  const blind = sessionFor({ fields: [] });
  const map = await odooFields(blind.session, "k5", ["hr.payslip"]);
  assert.deepEqual(map.get("hr.payslip"), []);
});

test("the tables a question is about are picked by its own words, with the usual ones always there", async () => {
  const catalog = await odooCatalog(sessionFor().session, "k6");
  assert.ok(pickModels(catalog, "كم لوط منتهي").includes("pos.order"), "the core tables are always offered");
  assert.ok(pickModels(catalog, "payslip net wage").includes("hr.payslip"), "and the question can reach past them");
  assert.ok(pickModels(catalog, "أي إشي", 2).length <= 2, "the prompt is the budget");
});

test("the prompt slice names each table with its fields and types, and skips the ones with none", async () => {
  const slice = await promptCatalog(sessionFor().session, "k7", "لوطات منتهية", 6);
  assert.match(slice, /stock\.lot \(Lot\/Serial Number\): expiration_date:datetime/);
  assert.match(slice, /pos\.order .*amount_total:monetary/);
  assert.ok(!slice.includes("ir.cron"));
});

// The live system has 678 tables and 12,963 stored fields (measured
// 2026-09-17), so "put the schema in the prompt" is a budget question, not a
// formality. These caps are what keeps a question from carrying thousands of
// tokens of fields nobody asked about.
test("the prompt slice is capped in both directions, however big the database is", async () => {
  const many = Array.from({ length: 40 }, (unused, index) => ({ model: `x.model${index}`, name: `Model ${index}` }));
  const manyFields = many.flatMap(info => Array.from({ length: 80 }, (unused, index) => ({
    model: info.model, name: `field_${index}`, ttype: "char", field_description: `Field ${index}`,
  })));
  const slice = await promptCatalog(sessionFor({ models: many, fields: manyFields }).session, "big", "model1 model2 model3");
  const lines = slice.split("\n");
  assert.ok(lines.length <= 12, `tables in the prompt: ${lines.length}`);
  for (const line of lines) {
    assert.ok(line.split(", ").length <= 30, "fields per table in the prompt");
  }
});
