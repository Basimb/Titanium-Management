import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOdooReportJobs } from "../lib/odoo-reports.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY);");
  return db;
}

const odoo = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@pharmacy.example.com", apiKey: "secret-key" };

function odooFetcher({ orderCount = 5, totalAmount = 250.5, lowStock = [], activeProducts = 100 } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const result = body.params.service === "common" ? 1
      : body.params.args[4] === "read_group" ? [{ amount_total: totalAmount, __count: orderCount }]
      : body.params.args[4] === "search_read" ? lowStock.map(item => ({ name: item.name, qty_available: item.qty }))
      : 0 + activeProducts;
    return { ok: true, json: async () => ({ result }) };
  };
}

const DAILY_AT = Date.UTC(1970, 0, 2, 21, 0, 0); // Friday 21:00 UTC -- matches the default daily hour
const WEEKLY_AT = Date.UTC(1970, 0, 3, 20, 0, 0); // Saturday 20:00 UTC -- matches the default weekly slot

test("disabled config never calls the network or sends anything", async t => {
  const db = fixture(t);
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: false, odoo, ownerNumber: "962790000000", groupId: "1@g.us",
    timezoneOffsetMinutes: 0, fetcher: async () => assert.fail("must not fetch when disabled"),
  } });
  const result = await jobs.deliverNext(async () => assert.fail("must not send when disabled"));
  assert.deepEqual(result, { status: "idle" });
});

test("outside the configured hour, nothing is due", async t => {
  const db = fixture(t);
  const jobs = createOdooReportJobs({ db, now: () => Date.UTC(1970, 0, 2, 12, 0, 0), config: {
    enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us",
    timezoneOffsetMinutes: 0, fetcher: async () => assert.fail("must not fetch off-schedule"),
  } });
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail("nothing to send")), { status: "idle" });
});

test("at the daily slot, sends the short report once to the group and once to the owner, then goes idle for the day", async t => {
  const db = fixture(t);
  const sent = [];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ orderCount: 12, totalAmount: 340.25, lowStock: [{ name: "بنادول", qty: 2 }] }),
  } });
  const first = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(first.status, "sent");
  const second = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(second.status, "sent");
  assert.deepEqual(sent.sort(), ["1@g.us", "962790000000@s.whatsapp.net"]);
  const third = await jobs.deliverNext(async () => assert.fail("must not send a third report the same day"));
  assert.deepEqual(third, { status: "idle" });
});

test("the daily report text carries the sales total, order count, and a low-stock warning", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ orderCount: 12, totalAmount: 340.25, lowStock: [{ name: "بنادول", qty: 2 }, { name: "أموكسيل", qty: 0 }] }),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /📊 تقرير المبيعات اليومي/);
  assert.match(text, /340\.25/);
  assert.match(text, /12 عملية بيع/);
  assert.match(text, /⚠️ 2 صنف/);
});

test("at the weekly slot, sends the fuller report with the low-stock list and active product count", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => WEEKLY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ orderCount: 80, totalAmount: 2400, lowStock: [{ name: "بنادول", qty: 2 }], activeProducts: 314 }),
  } });
  const result = await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.equal(result.status, "sent");
  assert.match(text, /📈 التقرير الأسبوعي/);
  assert.match(text, /314/);
  assert.match(text, /بنادول — الكمية: 2/);
});

test("a group-only configuration never messages the owner, and vice versa", async t => {
  const db = fixture(t);
  const sent = [];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0, fetcher: odooFetcher(),
  } });
  await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail("only one target was configured")), { status: "idle" });
  assert.deepEqual(sent, ["1@g.us"]);
});

test("when Odoo cannot be reached, an honest failure notice still goes out instead of nothing at all", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: async () => { throw new Error("network down"); },
  } });
  const result = await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.equal(result.status, "sent");
  assert.match(text, /تعذر جلب تقرير المبيعات اليومي/);
});
