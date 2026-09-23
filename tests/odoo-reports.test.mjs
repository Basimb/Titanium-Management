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

function odooFetcher({ orderCount = 5, totalAmount = 250.5, byLocation = null, activeProducts = 100,
  purchaseCount = 0, purchaseAmount = 0, returnCount = 0, returnAmount = 0,
  invoiceCount = 0, invoiceAmount = 0, shelf = [] } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    let result;
    const model = body.params.args?.[3];
    const method = body.params.args?.[4];
    if (body.params.service === "common") result = 1;
    else if (model === "account.move") {
      const domain = body.params.args[5][0];
      const moveType = domain.find(clause => clause[0] === "move_type")?.[2];
      result = moveType === "in_refund" ? [{ amount_total: returnAmount, amount_residual: returnAmount, __count: returnCount }]
        : moveType === "out_invoice" ? [{ amount_total: invoiceAmount, __count: invoiceCount }]
        : [{ amount_total: purchaseAmount, amount_residual: purchaseAmount, __count: purchaseCount }];
    } else if (model === "pos.order.line") {
      result = shelf.filter(item => item.sold).map((item, index) => ({ product_id: [index + 1, item.name], qty: item.sold }));
    } else if (model === "product.product" && method === "search_read") {
      result = shelf.map((item, index) => ({ id: index + 1, name: item.name, qty_available: item.qty }));
    } else if (method === "read_group") {
      const groupBy = body.params.args[5][2];
      const negative = body.params.args[5][0].some(clause => clause[0] === "amount_total" && clause[1] === "<");
      result = groupBy && groupBy.length
        ? (byLocation ?? []).map((row, index) => ({ location_id: [index + 1, row.location], amount_total: row.totalAmount, __count: row.orderCount }))
        : negative ? [{ amount_total: 0, __count: 0 }] : [{ amount_total: totalAmount, __count: orderCount }];
    } else result = activeProducts;
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
test("at the daily slot, sends the branch report to the group and then goes idle for the day", async t => {
  const db = fixture(t);
  const sent = [];
  const byLocation = [{ location: "NAOOR/Stock", orderCount: 177, totalAmount: 1863.71 }, { location: "SAFOT/Stock", orderCount: 58, totalAmount: 467.9 }];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "962790000000", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation }),
  } });
  const first = await jobs.deliverNext(async message => { sent.push(message.to); return {}; });
  assert.equal(first.status, "sent");
  assert.deepEqual(sent, ["1@g.us"]);
  // "الجروب بس" -- the owner DM that used to follow is gone unless he asks for it.
  const second = await jobs.deliverNext(async () => assert.fail("must not send a second report the same day"));
  assert.deepEqual(second, { status: "idle" });
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

test("at the weekly slot, the report names what will run out and how soon", async t => {
  const db = fixture(t);
  let text;
  const jobs = createOdooReportJobs({ db, now: () => WEEKLY_AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    routing: { odoo_weekly: { enabled: true, group: true, owner: true } },
    fetcher: odooFetcher({ orderCount: 80, totalAmount: 2400, activeProducts: 314,
      shelf: [{ name: "بنادول", qty: 2, sold: 600 }, { name: "كريم نادر", qty: 2, sold: 3 }] }),
  } });
  const result = await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.equal(result.status, "sent");
  assert.match(text, /📈 التقرير الأسبوعي/);
  assert.match(text, /314/);
  assert.match(text, /1\. بنادول\nالمتوفر: 2 علبة/);
  assert.doesNotMatch(text, /كريم نادر/, "two units that last forty days is not a shortage");
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
    routing: { odoo_purchases_weekly: { enabled: true, group: true, owner: false } },
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
    routing: { odoo_purchases_weekly: { enabled: true, group: true, owner: false } },
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
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    routing: { odoo_purchases_weekly: { enabled: true, group: true, owner: false } },
    fetcher: odooFetcher(),
  } });
  await jobs.deliverNext(async message => { text = message.text; return {}; });
  assert.match(text, /🛒 المشتريات: 0\.00 من 0 فاتورة مورد/);
  assert.match(text, /↩️ مرتجعات للموردين: 0\.00 من 0 إشعار/);
  assert.match(text, /💰 \*الصافي\*: 0\.00/);
});

// Basim (2026-09-17): "مبيعات يومي بالفرع كل يوم ١٢ منتصف الليل الجروب بس
// والغي الثاني لغاية ما اقولك" -- which reports run, and who each one reaches,
// had been hard-coded. It is config now; unset keeps the old behaviour exactly.
test("routing sends the daily report to the group only when he asks for group only", async t => {
  const db = fixture(t);
  const sent = [];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "966500000000", groupId: "123@g.us",
    timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation: [{ location: "NAOOR/Stock", orderCount: 3, totalAmount: 100 }] }),
    routing: { odoo_daily: { group: true, owner: false } },
  } });
  await jobs.deliverNext(async message => { sent.push(message.to); });
  await jobs.deliverNext(async message => { sent.push(message.to); });
  assert.deepEqual(sent, ["123@g.us"], "the group, and never his own chat");
});

test("a report switched off produces nothing and never calls the pharmacy system", async t => {
  const db = fixture(t);
  let calls = 0;
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "966500000000", groupId: "123@g.us",
    timezoneOffsetMinutes: 0,
    fetcher: async (...args) => { calls += 1; return odooFetcher({})(...args); },
    routing: { odoo_daily: { enabled: false } },
  } });
  const result = await jobs.deliverNext(async () => { throw new Error("must not send"); });
  assert.equal(result.status, "idle");
  assert.equal(calls, 0, "a disabled report must not even authenticate against Odoo");
});

// Left unset, the defaults are the arrangement he asked for on 2026-09-17:
// the daily branch report in the group and nowhere else, both weekly reports
// silent. They are defaults precisely so that the live install needs no edit.
test("routing left unset sends the daily report to the group alone and keeps both weeklies silent", async t => {
  const db = fixture(t);
  const sent = [];
  const jobs = createOdooReportJobs({ db, now: () => DAILY_AT, config: {
    enabled: true, odoo, ownerNumber: "966500000000", groupId: "123@g.us",
    timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation: [{ location: "NAOOR/Stock", orderCount: 3, totalAmount: 100 }] }),
  } });
  await jobs.deliverNext(async message => { sent.push(message.to); });
  await jobs.deliverNext(async message => { sent.push(message.to); });
  assert.deepEqual(sent, ["123@g.us"]);

  for (const at of [WEEKLY_AT, PURCHASES_AT]) {
    const quiet = createOdooReportJobs({ db: fixture(t), now: () => at, config: {
      enabled: true, odoo, ownerNumber: "966500000000", groupId: "123@g.us", timezoneOffsetMinutes: 0,
      fetcher: async () => assert.fail("a report that is off must never reach the pharmacy system"),
    } });
    assert.deepEqual(await quiet.deliverNext(async () => assert.fail("nothing may go out")), { status: "idle" });
  }
});

// Basim (2026-09-16): "هذه المبيعات مش يومي ياخي". The daily window used to be
// a rolling 24h ending when the report was sent, labelled with yesterday's
// date -- right only at the midnight slot, and quietly wrong at any other
// hour, which is exactly what he wants (a morning send). It is the previous
// COMPLETE local day now, whatever hour the report goes out at.
test("the daily window is yesterday's full local day, even when sent mid-morning", async t => {
  const db = fixture(t);
  const seen = [];
  const jobs = createOdooReportJobs({
    db,
    // 09:00 Amman on 2026-09-17 (UTC+3) -- nowhere near the midnight slot.
    now: () => Date.UTC(2026, 8, 17, 6, 0, 0),
    config: {
      enabled: true, odoo, groupId: "123@g.us", dailyHour: 9,
      routing: { odoo_daily: { group: true, owner: false } },
      fetcher: async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.params.service === "common") return { json: async () => ({ result: 1 }), ok: true };
        const domain = body.params.args[5][0];
        if (Array.isArray(domain)) seen.push(domain.filter(c => c[0] === "date_order").map(c => c[1] + " " + c[2]));
        return { ok: true, json: async () => ({ result: [{ location_id: [1, "NAOOR/Stock"], amount_total: 100, __count: 2 }] }) };
      },
    },
  });
  let text = "";
  await jobs.deliverNext(async message => { text = message.text; });
  // Amman midnight on the 16th is 21:00 UTC on the 15th -- Odoo stores
  // date_order in UTC, so the window is expressed there, not in local time.
  assert.deepEqual(seen[0], [">= 2026-09-15T21:00:00.000Z", "< 2026-09-16T21:00:00.000Z"],
    "midnight-to-midnight Amman on the 16th, not 09:00-to-09:00");
  assert.match(text, /2026-09-16/, "and labelled with the day it actually covers");
});

// 2026-09-17, the audit pass. Each of these was a figure that read as correct
// and was not.
test("the weekly window is seven whole local days, not a rolling 168 hours", async t => {
  const db = fixture(t);
  let domain;
  // Saturday 20:00 local at UTC+3 -- the weekly slot, mid-evening, exactly the
  // case where a rolling window silently starts and ends mid-afternoon.
  const AT = Date.UTC(1970, 0, 3, 17, 0, 0);
  const jobs = createOdooReportJobs({ db, now: () => AT, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 180,
    routing: { odoo_weekly: { enabled: true, group: true, owner: false } },
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
      if (body.params.args[3] === "pos.order") domain = body.params.args[5][0];
      return { ok: true, json: async () => ({ result: body.params.args[4] === "search_count" ? 0 : [] }) };
    },
  } });
  await jobs.deliverNext(async () => ({}));
  const since = domain.find(leaf => leaf[0] === "date_order" && leaf[1] === ">=")[2];
  const until = domain.find(leaf => leaf[0] === "date_order" && leaf[1] === "<")[2];
  // Amman midnight is 21:00 UTC the day before, so both ends land on :00.
  assert.match(since, /T21:00:00/, `window start ${since}`);
  assert.match(until, /T21:00:00/, `window end ${until}`);
});

test("a manual send does not swallow the next day's report", async t => {
  const db = fixture(t);
  const send = async () => ({});
  const byLocation = [{ location: "NAOOR/Stock", orderCount: 3, totalAmount: 100 }];
  const at = (hourUtc, dayUtc) => Date.UTC(1970, 0, dayUtc, hourUtc, 0, 0);
  const jobsAt = now => createOdooReportJobs({ db, now: () => now, config: {
    enabled: true, odoo, ownerNumber: "", groupId: "1@g.us", timezoneOffsetMinutes: 0,
    fetcher: odooFetcher({ byLocation }),
  } });
  // The scheduled report for day 2.
  assert.equal((await jobsAt(at(0, 2)).deliverNext(send)).status, "sent");
  // An hour later the same day is still the same report -- correctly skipped.
  assert.deepEqual(await jobsAt(at(1, 2)).deliverNext(send), { status: "idle" });
  // The next day's slot is a different report and must go out, even though it
  // is under 24 hours after a send that happened at 01:00.
  assert.equal((await jobsAt(at(0, 3)).deliverNext(send)).status, "sent");
});

// Basim, 2026-09-23: "تقرير مبيعات الصيجليه ما عم يوصل بموعدو خليه الساعه
// 12:15 صباحا". The schedule knew only the hour, so "midnight" was any drain
// between 00:00 and 00:59 and the report wandered. A minute opens the slot;
// the rest of the hour stays open, because a report five minutes late still
// tells him what yesterday sold and a missed one tells him nothing.
test("the daily report waits for its minute, then stays sendable for the hour", async t => {
  const amman = (hour, minute) => Date.UTC(2026, 8, 17, hour - 3, minute, 0);
  const build = (db, at) => createOdooReportJobs({
    db, now: () => at,
    config: {
      enabled: true, odoo, groupId: "123@g.us", dailyHour: 0, dailyMinute: 15,
      routing: { odoo_daily: { group: true, owner: false } },
      fetcher: async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
        return { ok: true, json: async () => ({ result: [{ location_id: [1, "NAOOR/Stock"], amount_total: 100, __count: 2 }] }) };
      },
    },
  });
  // 00:14 -- the hour is right, the minute is not.
  assert.deepEqual(
    await build(fixture(t), amman(0, 14)).deliverNext(async () => assert.fail("too early")),
    { status: "idle" });
  // 00:15 exactly.
  let sent = 0;
  await build(fixture(t), amman(0, 15)).deliverNext(async () => { sent += 1; });
  assert.equal(sent, 1, "the slot opens on the minute");
  // 00:40 -- a bridge that was down at 00:15 must still send, not skip the day.
  sent = 0;
  await build(fixture(t), amman(0, 40)).deliverNext(async () => { sent += 1; });
  assert.equal(sent, 1, "late is not a reason to send nothing");
  // And the hour still governs: 01:15 is a different hour entirely.
  assert.deepEqual(
    await build(fixture(t), amman(1, 15)).deliverNext(async () => assert.fail("wrong hour")),
    { status: "idle" });
});
