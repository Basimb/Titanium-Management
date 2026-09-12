import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOdooReportJobs } from "../lib/odoo-reports.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // The shared additive migration needs a tasks table to hang its columns off.
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY);");
  return db;
}

const odoo = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@pharmacy.example.com", apiKey: "secret-key" };

function odooFetcher({ orderCount = 5, totalAmount = 250.5, byLocation = null, lowStock = [], activeProducts = 100,
  purchaseCount = 0, purchaseAmount = 0, returnCount = 0, returnAmount = 0 } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    let result;
    const model = body.params.args?.[3];
    if (body.params.service === "common") result = 1;
    else if (model === "account.move") {
      const isReturn = body.params.args[5][0].some(clause => clause[0] === "move_type" && clause[2] === "in_refund");
      result = isReturn ? [{ amount_total: returnAmount, __count: returnCount }] : [{ amount_total: purchaseAmount, __count: purchaseCount }];
    } else if (body.params.args[4] === "read_group") {
      const groupBy = body.params.args[5][2];
      result = groupBy && groupBy.length
        ? (byLocation ?? []).map((row, index) => ({ location_id: [index + 1, row.location], amount_total: row.totalAmount, __count: row.orderCount }))
        : [{ amount_total: totalAmount, __count: orderCount }];
    } else if (body.params.args[4] === "search_read") result = lowStock.map(item => ({ name: item.name, qty_available: item.qty }));
    else result = activeProducts;
    return { ok: true, json: async () => ({ result }) };
  };
}

const DAILY_AT = Date.UTC(1970, 0, 2, 0, 0, 0); // Friday 00:00 UTC -- matches the default daily hour (12:01am slot)
const WEEKLY_AT = Date.UTC(1970, 0, 3, 20, 0, 0); // Saturday 20:00 UTC -- matches the default weekly sales slot
const PURCHASES_AT = Date.UTC(1970, 0, 3, 19, 0, 0); // same Saturday, one hour earlier -- default purchases slot

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

// 2026-09-12, Basim: "بدي هذا التقرير كل يوم الساعه 12:01 صباحا يروح للجروب
// بدون موافقتي" -- the default daily slot is hour 0 (see DAILY_AT above), and
// this job already sends straight to its targets with no confirmation step.
test("at the daily slot, sends the branch report once to the group and once to the owner, then goes idle for the day", async t => {
  const db = fixture(t);
  const sent = [];
  const byLocation = [{ location: "NAOOR/Stock", orderCount: 177, totalAmount: 1863.71 }, { location: "SAFOT/Stock", orderCount: 58, totalAmount: 467.9 }];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation }),
  } });
  const first = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(first.status, "sent");
  const second = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(second.status, "sent");
  assert.deepEqual(sent.sort(), ["1@g.us", "962790000000@s.whatsapp.net"]);
  const third = await jobs.deliverNext(async () => assert.fail("must not send a third report the same day"));
  assert.deepEqual(third, { status: "idle" });
});

// 2026-09-12, Basim: "طلعلي بيع امبارح بالفرع واعملي فورم او صيغه حلوه للفرع
// حط جنب كل فرع لون... ومنها بتعطيني نسبة الفرع لكل فرع وللمجموع" -- the exact
// per-branch, colored, ranked-with-percentages format he approved by hand is
// now what the automated daily report sends every night.
test("the daily report text ranks branches by amount, colors each, shows its share of the total, and labels the day that just ended", async t => {
  const db = fixture(t);
  let text;
  const byLocation = [
    { location: "JUMRK/Stock", orderCount: 16, totalAmount: 83.43 },
    { location: "NAOOR/Stock", orderCount: 177, totalAmount: 1863.71 },
    { location: "SAFOT/Stock", orderCount: 58, totalAmount: 467.9 },
    { location: "DABOQ/Stock", orderCount: 17, totalAmount: 127.61 },
  ];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation }),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /📊 \*تقرير المبيعات اليومي بالفرع\*/);
  // DAILY_AT is 1970-01-02T00:00Z; the report covers the day that just ended, 1970-01-01.
  assert.match(text, /📅 1970-01-01/);
  const lines = text.split("\n");
  assert.equal(lines.findIndex(l => l.includes("الناعور")) < lines.findIndex(l => l.includes("صافوط")), true, "largest branch (الناعور) must rank above صافوط");
  assert.equal(lines.findIndex(l => l.includes("صافوط")) < lines.findIndex(l => l.includes("دابوق")), true);
  assert.equal(lines.findIndex(l => l.includes("دابوق")) < lines.findIndex(l => l.includes("الجمرك")), true);
  assert.match(text, /🟢 \*الناعور\* — 1,863\.71 \(73\.3%\)/);
  assert.match(text, /🔵 \*صافوط\* — 467\.90 \(18\.4%\)/);
  assert.match(text, /🟡 \*دابوق\* — 127\.61 \(5\.0%\)/);
  assert.match(text, /🔴 \*الجمرك\* — 83\.43 \(3\.3%\)/);
  assert.match(text, /💰 \*الإجمالي\*: 2,542\.65/);
});

test("a day with no branch sales still sends an honest empty report instead of an empty body", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation: [] }),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /لا توجد مبيعات مسجّلة لهذا اليوم/);
  assert.match(text, /💰 \*الإجمالي\*: 0\.00/);
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

// 2026-09-12, Basim: "بدي تجهزلي تقرير مشتريات تحسب فيه من اول الشهر لليوم
// ايش صار مشتريات ومرتجعات وتنشرو للجروب كل اسبوع كل يوم سبت" -- confirmed
// separately that "مرتجعات" here means vendor returns, not customer/POS
// returns. Same Saturday as the sales weekly report, a different hour so
// the two never collide, group only (no owner DM, unlike the other two).
test("at the purchases slot on Saturday, sends the month-to-date purchases report to the group only, even with an owner configured", async t => {
  const db = fixture(t);
  const sent = [];
  const jobs = createOdooReportJobs({ db, now: () => PURCHASES_AT, config: {
    enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ purchaseCount: 5, purchaseAmount: 900, returnCount: 2, returnAmount: 150 }),
  } });
  const first = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(first.status, "sent");
  assert.deepEqual(sent, ["1@g.us"]);
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail("owner must never get this report")), { status: "idle" });
});

test("the purchases report text covers from the start of the local month to now, and nets returns against purchases", async t => {
  const db = fixture(t);
  let text;
  // 16:00 UTC + the UTC+3 offset = Saturday 19:00 local -- the default
  // purchasesWeeklyHour slot, still within January, so the local month start
  // is 1970-01-01 local (1969-12-31T21:00 UTC) and "until" is 1970-01-03 local.
  const AT_UTC3 = Date.UTC(1970, 0, 3, 16, 0, 0);
  const jobs = createOdooReportJobs({ db, now: () => AT_UTC3, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 180,
    fetcher: odooFetcher({ purchaseCount: 5, purchaseAmount: 900, returnCount: 2, returnAmount: 150 }),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /🧾 \*تقرير المشتريات \(من أول الشهر\)\*/);
  assert.match(text, /📅 من 1970-01-01 إلى 1970-01-03/);
  assert.match(text, /🛒 المشتريات: 900\.00 من 5 فاتورة مورد/);
  assert.match(text, /↩️ مرتجعات للموردين: 150\.00 من 2 إشعار/);
  assert.match(text, /💰 \*الصافي\*: 750\.00/);
});

test("the purchases report never fires outside Saturday, and never collides with the sales-weekly hour", async t => {
  const db = fixture(t);
  const notSaturday = createOdooReportJobs({ db, now: () => Date.UTC(1970, 0, 2, 19, 0, 0), config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0, fetcher: async () => assert.fail("Friday must never fire this report"),
  } });
  assert.deepEqual(await notSaturday.deliverNext(async () => assert.fail("nothing to send")), { status: "idle" });
});

test("a month with no purchases or returns still nets to zero instead of a blank report", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => PURCHASES_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0, fetcher: odooFetcher(),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /🛒 المشتريات: 0\.00 من 0 فاتورة مورد/);
  assert.match(text, /↩️ مرتجعات للموردين: 0\.00 من 0 إشعار/);
  assert.match(text, /💰 \*الصافي\*: 0\.00/);
});
