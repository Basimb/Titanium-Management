// The validator is the whole safety story for the composed-query layer: the
// model may now name any table in the pharmacy's database, so what it may NOT
// do has to be enforced here rather than asked for in a prompt. Most of these
// tests are refusals on purpose -- a query this file accepts runs against
// Basim's live business system.
import test from "node:test";
import assert from "node:assert/strict";
import { validateOdooQuery, describeOdooQuery } from "../lib/odoo-query.ts";

const sales = { model: "pos.order", method: "read_group", domain: [["state", "in", ["paid", "done"]]], fields: ["amount_total"], groupBy: ["location_id"] };

test("a well-formed query comes back with a row cap it did not have to ask for", () => {
  const query = validateOdooQuery(sales);
  assert.equal(query.model, "pos.order");
  assert.deepEqual(query.groupBy, ["location_id"]);
  assert.equal(query.limit, 50, "an unbounded read of a live system is never allowed");
});

test("only the three read methods exist", () => {
  for (const method of ["search_read", "read_group", "search_count"]) {
    const base = method === "search_count" ? { model: "pos.order", method, domain: [] }
      : { model: "pos.order", method, domain: [], fields: ["amount_total"] };
    assert.ok(validateOdooQuery(base), method);
  }
  for (const method of ["write", "create", "unlink", "search_write", "execute", "", "READ_GROUP", null, 5]) {
    assert.equal(validateOdooQuery({ ...sales, method }), null, String(method));
  }
});

test("a model name has to look like a model name", () => {
  for (const model of ["product", "", "pos.order; drop", "POS.ORDER", "pos..order", "../etc/passwd",
    "a".repeat(61) + ".x", 42, null, { }]) {
    assert.equal(validateOdooQuery({ ...sales, model }), null, String(model));
  }
  assert.ok(validateOdooQuery({ ...sales, model: "stock.warehouse.orderpoint" }));
});

test("a domain leaf is three parts, a known operator, and a value of a shape we recognise", () => {
  const ok = leaf => validateOdooQuery({ ...sales, domain: [leaf] });
  assert.ok(ok(["state", "=", "paid"]));
  assert.ok(ok(["lot_id.expiration_date", "<", "2026-09-17"]));
  assert.ok(ok(["amount_total", ">=", 100.5]));
  assert.ok(ok(["partner_id", "!=", false]));
  for (const bad of [
    ["state", "=~", "paid"],            // invented operator
    ["state", "=="],                     // not three parts
    ["state", "=", "paid", "extra"],
    ["State", "=", "paid"],              // fields are lower case in Odoo
    ["a.b.c.d.e", "=", 1],               // too many joins
    ["state", "=", { nested: true }],
    ["state", "in", "paid"],             // `in` takes a list
    ["state", "=", "x".repeat(201)],
    "state = paid",
  ]) assert.equal(ok(bad), null, JSON.stringify(bad));
});

test("the connectives Odoo itself uses are allowed through untouched", () => {
  const query = validateOdooQuery({ ...sales, domain: ["|", ["state", "=", "paid"], ["state", "=", "done"]] });
  assert.deepEqual(query.domain[0], "|");
});

test("a query is refused, never repaired", () => {
  // read_group with nothing to aggregate is not a question anyone asked.
  assert.equal(validateOdooQuery({ model: "pos.order", method: "read_group", domain: [] }), null);
  // Extras on a count would come back as a bare number without saying so.
  assert.equal(validateOdooQuery({ model: "pos.order", method: "search_count", domain: [], fields: ["amount_total"] }), null);
  // groupBy belongs to read_group alone.
  assert.equal(validateOdooQuery({ model: "pos.order", method: "search_read", domain: [], fields: ["name"], groupBy: ["state"] }), null);
});

test("limits and ordering stay inside what a live system should be asked for", () => {
  // 2000 is the metadata ceiling -- reading the database map legitimately runs
  // to hundreds of rows. Everyday questions still default to 50.
  assert.equal(validateOdooQuery({ ...sales, limit: 2000 }).limit, 2000);
  assert.equal(validateOdooQuery(sales).limit, 50);
  for (const limit of [0, -1, 2001, 5.5, "50", null]) {
    assert.equal(validateOdooQuery({ ...sales, limit }), null, String(limit));
  }
  const ordered = validateOdooQuery({ model: "product.product", method: "search_read", domain: [], fields: ["name"], order: "qty_available asc" });
  assert.equal(ordered.order, "qty_available asc");
  for (const order of ["qty_available ascending", "name; drop", "qty_available asc --", "x".repeat(101)]) {
    assert.equal(validateOdooQuery({ model: "product.product", method: "search_read", domain: [], fields: ["name"], order }), null, order);
  }
});

test("paging is allowed, within reason", () => {
  assert.equal(validateOdooQuery({ ...sales, offset: 200 }).offset, 200);
  assert.equal(validateOdooQuery({ ...sales, offset: 0 }).offset, 0);
  for (const offset of [-1, 100_001, 1.5, "0"]) {
    assert.equal(validateOdooQuery({ ...sales, offset }), null, String(offset));
  }
});

test("a date granularity is allowed on a group, but only a real one", () => {
  assert.ok(validateOdooQuery({ ...sales, groupBy: ["date_order:month"] }));
  assert.equal(validateOdooQuery({ ...sales, groupBy: ["date_order:fortnight"] }), null);
});

test("nothing that is not an object is a query", () => {
  for (const input of [null, undefined, "pos.order", 5, [], [["state", "=", "paid"]]]) {
    assert.equal(validateOdooQuery(input), null, JSON.stringify(input) ?? "undefined");
  }
});

// The footer is the only defence against a query that is valid, real, and
// answering a different question than the one asked. It has to name the table
// and read the filter back, or Basim cannot catch the wrong filter himself.
test("the footer says which table, which filter, and what came out", () => {
  const text = describeOdooQuery(validateOdooQuery({
    model: "account.move", method: "read_group",
    domain: [["move_type", "=", "in_invoice"], ["state", "=", "posted"], ["invoice_date", ">=", "2026-09-01"]],
    fields: ["amount_total"], groupBy: ["partner_id"],
  }));
  assert.match(text, /account\.move/);
  assert.match(text, /move_type = in_invoice/);
  assert.match(text, /invoice_date ≥ 2026-09-01/);
  assert.match(text, /مجموع amount_total/);
  assert.match(text, /مجمّع حسب partner_id/);
});

test("the footer is honest about a query with no filter at all", () => {
  const text = describeOdooQuery(validateOdooQuery({ model: "stock.lot", method: "search_count", domain: [] }));
  assert.match(text, /بدون — كل السجلات/);
  assert.match(text, /عدد السجلات/);
});

test("the footer reads back list values and booleans the way a person would say them", () => {
  const text = describeOdooQuery(validateOdooQuery({
    model: "pos.order", method: "search_count",
    domain: [["state", "in", ["paid", "done", "invoiced"]], ["partner_id", "!=", false]],
  }));
  assert.match(text, /state ضمن \(paid، done، invoiced\)/);
  assert.match(text, /partner_id ≠ لأ/);
});
