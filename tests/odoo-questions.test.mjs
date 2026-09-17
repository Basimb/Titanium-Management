// Basim asked to be able to ask the secretary about the pharmacy system live
// ("اسأله لايف ويجاوب") on the same night he had finished taking the model out
// of every tap decision. So the matching is written out by hand here and
// tested by hand: a question either lands on exactly one query, or on none at
// all. A wrong number would be worse than no answer, because he acts on it.
import test from "node:test";
import assert from "node:assert/strict";
import { matchOdooQuestion, answerOdooQuestion, normalizeArabic, forgetOdooAnswers, looksLikeOdooQuestion } from "../lib/odoo-questions.ts";
import { forgetOdooSessions } from "../lib/odoo-client.ts";

// Answers are cached for a minute and logins for half an hour, both keyed by
// the fetcher, so one test can never be handed another test's numbers.
test.beforeEach(() => { forgetOdooAnswers(); forgetOdooSessions(); });

const odoo = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@x.com", apiKey: "k" };
// 2026-09-17 12:00 Amman
const AT = Date.UTC(2026, 8, 17, 9, 0);

function fetcherFor(handlers) {
  const calls = [];
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
    const [, , , model, method, args, kwargs] = body.params.args;
    calls.push({ model, method, domain: args[0], kwargs });
    const handler = handlers[model];
    return { ok: true, json: async () => ({ result: handler ? handler(args, method) : [] }) };
  };
  return { fetcher, calls };
}

test("each wording lands on the question it means", () => {
  const cases = [
    ["شو مبيعات اليوم؟", "sales_today", null],
    ["كم بعنا اليوم", "sales_today", null],
    ["مبيعاتنا", "sales_today", null],
    ["مبيعات امبارح", "sales_yesterday", null],
    ["شو مبيعات الشهر", "sales_month", null],
    ["مبيعات الناعور اليوم", "sales_today", "NAOOR"],
    ["كم بعنا بصافوط", "sales_today", "SAFOT"],
    ["شو ناقص من المخزون", "low_stock", null],
    ["شو بينتهي خلال شهر", "expiring", null],
    ["في اشي منتهي الصلاحية؟", "expiring", null],
    ["كم فاتورة مورد مش مدفوعة", "unpaid_bills", null],
    ["شو المشتريات هالشهر", "purchases_month", null],
  ];
  for (const [text, kind, branch] of cases) {
    const match = matchOdooQuestion(text);
    assert.ok(match, `"${text}" should match something`);
    assert.equal(match.kind, kind, `"${text}"`);
    assert.equal(match.branch, branch, `"${text}" branch`);
  }
});

test("anything outside the set matches nothing, so no number is invented", () => {
  for (const text of ["كيف الحال", "خلصت المهمة", "بدي اضيف مهمة جديدة", "شو رأيك بالموظف الجديد", "", "x".repeat(300)]) {
    assert.equal(matchOdooQuestion(text), null, `"${text.slice(0, 20)}"`);
  }
});

test("a period word beats the bare sales question, so 'امبارح' is never read as today", () => {
  assert.equal(matchOdooQuestion("مبيعات امبارح").kind, "sales_yesterday");
  assert.equal(matchOdooQuestion("المبيعات هذا الشهر").kind, "sales_month");
  assert.equal(matchOdooQuestion("مبيعات").kind, "sales_today");
});

test("casual typing still matches -- no diacritics, ه for ة, folded hamza", () => {
  assert.equal(normalizeArabic("المبيعاتُ"), "المبيعات");
  assert.equal(matchOdooQuestion("شو المبيعاتِ اليوم؟").kind, "sales_today");
  assert.equal(matchOdooQuestion("إيش ناقص").kind, "low_stock");
});

test("today's sales are asked for from local midnight to now, never a rolling day", async () => {
  const { fetcher, calls } = fetcherFor({ "pos.order": () => [{ location_id: [8, "NAOOR/Stock"], amount_total: 500, __count: 20 }] });
  const text = await answerOdooQuestion(matchOdooQuestion("مبيعات اليوم"), { odoo, currencyLabel: "دينار", fetcher }, AT);
  const bounds = calls[0].domain.filter(clause => clause[0] === "date_order").map(clause => clause[1] + " " + clause[2]);
  // Amman midnight on the 17th is 21:00 UTC on the 16th.
  assert.deepEqual(bounds, [">= 2026-09-16T21:00:00.000Z", "< 2026-09-17T09:00:00.000Z"]);
  assert.match(text, /مبيعات اليوم لحد الآن/);
  assert.match(text, /الناعور/);
  assert.match(text, /500\.00 دينار/);
});

test("naming a branch narrows the answer to that branch alone", async () => {
  const { fetcher } = fetcherFor({ "pos.order": () => [
    { location_id: [8, "NAOOR/Stock"], amount_total: 500, __count: 20 },
    { location_id: [20, "SAFOT/Stock"], amount_total: 300, __count: 9 },
  ] });
  const text = await answerOdooQuestion(matchOdooQuestion("مبيعات صافوط اليوم"), { odoo, fetcher }, AT);
  assert.match(text, /صافوط/);
  assert.doesNotMatch(text, /الناعور/);
  assert.match(text, /300\.00/);
});

test("a branch with no sales says so instead of showing a zero row", async () => {
  const { fetcher } = fetcherFor({ "pos.order": () => [{ location_id: [8, "NAOOR/Stock"], amount_total: 500, __count: 20 }] });
  const text = await answerOdooQuestion(matchOdooQuestion("مبيعات دابوق اليوم"), { odoo, fetcher }, AT);
  assert.match(text, /ما في مبيعات مسجّلة لفرع دابوق/);
});

test("expiry counts what is on the shelf, not how many lot records exist", async () => {
  const { fetcher, calls } = fetcherFor({ "stock.quant": args => {
    const expired = args[0].some(clause => clause[0] === "lot_id.expiration_date" && clause[1] === "<");
    return [{ __count: expired ? 2767 : 891, quantity: expired ? 11829 : 5003 }];
  } });
  const text = await answerOdooQuestion(matchOdooQuestion("شو بينتهي"), { odoo, fetcher }, AT);
  for (const call of calls) {
    assert.ok(call.domain.some(c => c[0] === "location_id.usage" && c[2] === "internal"), "internal locations only");
    assert.ok(call.domain.some(c => c[0] === "quantity" && c[1] === ">" && c[2] === 0), "positive quantity only");
  }
  assert.match(text, /11829/);
  assert.match(text, /5003/);
});

test("unpaid bills report the residual, not the invoice totals", async () => {
  const { fetcher, calls } = fetcherFor({ "account.move": () => [{ __count: 4487, amount_residual: 128450.5 }] });
  const text = await answerOdooQuestion(matchOdooQuestion("كم علينا للموردين"), { odoo, currencyLabel: "دينار", fetcher }, AT);
  assert.ok(calls[0].domain.some(c => c[0] === "payment_state"), "only unpaid or part-paid bills");
  assert.match(text, /4487/);
  assert.match(text, /128,450\.50 دينار/);
});

test("no unpaid bills reads as a sentence, not as a zero", async () => {
  const { fetcher } = fetcherFor({ "account.move": () => [] });
  const text = await answerOdooQuestion(matchOdooQuestion("ذمم الموردين"), { odoo, fetcher }, AT);
  assert.match(text, /ما في فواتير موردين غير مسدّدة/);
});

test("what is running out is what the shelf runs out of, not what sits under a unit count", async () => {
  const { fetcher, calls } = fetcherFor({
    // Sold over the 60-day window: fast mover, slow mover.
    "pos.order.line": () => [
      { product_id: [1, "بانادول"], qty: 600 },
      { product_id: [2, "كريم نادر"], qty: 3 },
    ],
    // Both hold two units. One is half a day of stock; the other is forty days.
    "product.product": () => [
      { id: 1, name: "بانادول", qty_available: 2 },
      { id: 2, name: "كريم نادر", qty_available: 2 },
      { id: 3, name: "صنف ما بيتحرك", qty_available: 1 },
    ],
  });
  const text = await answerOdooQuestion(matchOdooQuestion("شو ناقص من المخزون"), { odoo, fetcher }, AT);
  assert.match(text, /بانادول — باقي \*0\.2\* يوم \(2 قطعة، 10\.0\/يوم\)/);
  assert.doesNotMatch(text, /كريم نادر/, "two units that last forty days is not a shortage");
  assert.doesNotMatch(text, /ما بيتحرك/, "stock that never moves is never running out");
  // Only stock that exists is considered; the catalogue is not the shelf.
  const stockCall = calls.find(entry => entry.model === "product.product");
  assert.ok(stockCall.domain.some(leaf => leaf[0] === "qty_available" && leaf[1] === ">" && leaf[2] === 0));
});

test("when nothing on the shelf is about to run out, it says so plainly", async () => {
  const { fetcher } = fetcherFor({
    "pos.order.line": () => [{ product_id: [1, "بانادول"], qty: 30 }],
    "product.product": () => [{ id: 1, name: "بانادول", qty_available: 400 }],
  });
  const text = await answerOdooQuestion(matchOdooQuestion("شو ناقص من المخزون"), { odoo, fetcher }, AT);
  assert.match(text, /ما في صنف متحرّك رح يخلص خلال أسبوع/);
});

// Basim (2026-09-17): "بدي يصير جاوبني بسرعه فائقه". Two round trips per
// question -- log in, then ask -- is most of the wait, and the login half is
// pure overhead: the uid it returns never changes. These three tests are the
// reason the answer can come back in one trip, and often in none.
test("asking the same thing again inside the minute answers without touching the pharmacy system", async () => {
  const { fetcher, calls } = fetcherFor({ "pos.order": () => [{ location_id: [1, "NAOOR/Stock"], amount_total: 500, __count: 20 }] });
  const match = matchOdooQuestion("شو مبيعات اليوم؟");
  const first = await answerOdooQuestion(match, { odoo, fetcher }, AT);
  assert.equal(calls.length, 1);
  const again = await answerOdooQuestion(match, { odoo, fetcher }, AT + 30_000);
  assert.equal(again, first);
  assert.equal(calls.length, 1, "a repeat inside the window must not ask Odoo again");
  // Past the window the number is fetched fresh, because he acts on it.
  await answerOdooQuestion(match, { odoo, fetcher }, AT + 61_000);
  assert.equal(calls.length, 2);
});

test("a different question is never answered from another question's cache", async () => {
  const { fetcher, calls } = fetcherFor({
    "pos.order": () => [{ location_id: [1, "NAOOR/Stock"], amount_total: 500, __count: 20 }],
    "account.move": () => [{ amount_residual: 90, __count: 3 }],
  });
  await answerOdooQuestion(matchOdooQuestion("شو مبيعات اليوم؟"), { odoo, fetcher }, AT);
  const asked = calls.length;
  const bills = await answerOdooQuestion(matchOdooQuestion("كم فاتورة مورد مش مدفوعة"), { odoo, fetcher }, AT);
  assert.match(bills, /فواتير موردين/);
  assert.ok(calls.length > asked, "a different question asks Odoo again");
  assert.ok(calls.slice(asked).every(entry => entry.model === "account.move"));
  // A branch question is its own answer too, never the all-branches one.
  const branch = await answerOdooQuestion(matchOdooQuestion("مبيعات صافوط اليوم"), { odoo, fetcher }, AT);
  assert.match(branch, /ما في مبيعات مسجّلة لفرع صافوط/);
});

test("the login happens once and is reused by later questions, and a rejected login is retried once", async () => {
  forgetOdooSessions();
  let logins = 0;
  let rejectOnce = false;
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") { logins += 1; return { ok: true, json: async () => ({ result: 7 }) }; }
    if (rejectOnce) { rejectOnce = false; return { ok: true, json: async () => ({ error: { message: "session expired" } }) }; }
    return { ok: true, json: async () => ({ result: [{ amount_residual: 10, __count: 1 }] }) };
  };
  const match = matchOdooQuestion("كم فاتورة مورد مش مدفوعة");
  await answerOdooQuestion(match, { odoo, fetcher }, AT);
  assert.equal(logins, 1);
  await answerOdooQuestion(match, { odoo, fetcher }, AT + 61_000);
  assert.equal(logins, 1, "the second question must not log in again");
  // A uid the server no longer accepts costs one extra login, not an error.
  rejectOnce = true;
  const reply = await answerOdooQuestion(match, { odoo, fetcher }, AT + 122_000);
  assert.match(reply, /فواتير موردين/);
  assert.equal(logins, 2);
});

// Basim (2026-09-17): "اربطه مباشر بالمصطلحات العربيه مشان يفهمني". He should
// not have to remember one blessed phrasing, so the words the team actually
// uses are written out -- and the ones that live inside other words are
// matched as whole words only, or "دخلت المخزن" would read as a sales question.
test("the words the team actually uses all land on the right question", () => {
  const cases = [
    ["قديش الإيرادات اليوم", "sales_today"],
    ["شو المدخول", "sales_today"],
    ["كم كاش اليوم", "sales_today"],
    ["شو مبيعات الأسبوع", "sales_week"],
    ["مبيعات هالاسبوع", "sales_week"],
    ["شو الوضع بالنواقص", "low_stock"],
    ["في ذمم علينا؟", "unpaid_bills"],
    ["شو مستحقات الموردين", "unpaid_bills"],
    ["شو شرينا هالشهر", "purchases_month"],
    ["شو بتعرف تجاوب؟", "help"],
    ["شو بقدر اسألك", "help"],
  ];
  for (const [text, kind] of cases) {
    assert.equal(matchOdooQuestion(text)?.kind, kind, text);
  }
});

test("a word that merely contains a question word is not that question", () => {
  for (const text of ["دخلت على المخزن", "ذكّر خالد بالطلبية", "خلصت المهمة", "بعث الملف للمحاسب"]) {
    assert.equal(matchOdooQuestion(text), null, text);
  }
});

test("the misspellings the branches get typed with still find the branch", () => {
  assert.equal(matchOdooQuestion("مبيعات دبوق")?.branch, "DABOQ");
  assert.equal(matchOdooQuestion("مبيعات النعور")?.branch, "NAOOR");
  assert.equal(matchOdooQuestion("مبيعات صافوت اليوم")?.branch, "SAFOT");
  assert.equal(matchOdooQuestion("مبيعات الجمارك")?.branch, "JUMRK");
});

test("the help answer mentions the shifts too", async () => {
  const reply = await answerOdooQuestion({ kind: "help", branch: null },
    { odoo, fetcher: async () => assert.fail("the list never needs the pharmacy system") }, AT);
  assert.ok(reply.includes("الشفتات"));
  assert.ok(matchOdooQuestion("شفتات امبارح"), "every wording it advertises has to match something");
});

test("the help answer lists only questions that are really wired up", async () => {
  const reply = await answerOdooQuestion({ kind: "help", branch: null },
    { odoo, fetcher: async () => assert.fail("the list must never need the pharmacy system") }, AT);
  for (const wording of ["مبيعات اليوم", "مبيعات امبارح", "مبيعات الأسبوع", "مبيعات الشهر",
    "ناقص من المخزون", "الصلاحيات", "مش مدفوع", "المشتريات", "الناعور"]) {
    assert.ok(reply.includes(wording), wording);
  }
  // Every wording it advertises has to actually match something.
  for (const wording of ["شو مبيعات اليوم", "مبيعات امبارح", "مبيعات الأسبوع", "مبيعات الشهر",
    "شو ناقص من المخزون", "شو بينتهي قريب", "كم علينا مش مدفوع", "شو المشتريات هالشهر"]) {
    assert.ok(matchOdooQuestion(wording), wording);
  }
});

test("only a question is worth a routing call", () => {
  for (const text of ["قديش صار عنا بدابوق؟", "كم صرفنا", "شو الوضع", "وين وصلت الطلبية", "how much today"]) {
    assert.equal(looksLikeOdooQuestion(text), true, text);
  }
  for (const text of ["ذكّر خالد بالطلبية", "خلصت", "تمام", "ابعت التقرير للمحاسب"]) {
    assert.equal(looksLikeOdooQuestion(text), false, text);
  }
});

// 2026-09-17, the audit pass.
test("what we owe suppliers is net of the credit notes that reduce it", async () => {
  const { fetcher, calls } = fetcherFor({
    "account.move": (args) => {
      const type = args[0].find(leaf => leaf[0] === "move_type")[2];
      return type === "in_refund" ? [{ amount_residual: -140, __count: 2 }] : [{ amount_residual: 900, __count: 12 }];
    },
  });
  const reply = await answerOdooQuestion(matchOdooQuestion("كم علينا للموردين مش مدفوع"), { odoo, fetcher, currencyLabel: "دينار" }, AT);
  assert.match(reply, /العدد: \*12\* فاتورة/);
  assert.match(reply, /المتبقّي: \*900\.00 دينار\*/);
  assert.match(reply, /إشعارات خصم غير مطبّقة: \*140\.00 دينار\* من 2 إشعار/);
  assert.match(reply, /الصافي علينا\*: 760\.00 دينار/);
  assert.equal(calls.length, 2, "bills and credit notes, read apart");
});

test("with no credit notes outstanding, the answer stays the one line it always was", async () => {
  const { fetcher } = fetcherFor({
    "account.move": (args) => args[0].find(leaf => leaf[0] === "move_type")[2] === "in_refund" ? [] : [{ amount_residual: 900, __count: 12 }],
  });
  const reply = await answerOdooQuestion(matchOdooQuestion("كم علينا للموردين مش مدفوع"), { odoo, fetcher }, AT);
  assert.doesNotMatch(reply, /إشعارات خصم/);
  assert.doesNotMatch(reply, /الصافي علينا/);
});

// Between midnight and 3am in Amman the UTC date is still yesterday's, so an
// item expiring today was landing in the "already expired" bucket.
test("the expiry cutoff is the pharmacy's today, taken from the moment asked", async () => {
  let expired;
  const { fetcher } = fetcherFor({ "stock.quant": (args) => {
    const leaf = args[0].find(entry => entry[0] === "lot_id.expiration_date" && entry[1] === "<");
    if (leaf) expired = leaf[2];
    return [{ quantity: 5, __count: 1 }];
  } });
  // 2026-09-18 00:30 Amman == 2026-09-17 21:30 UTC. The pharmacy's today is
  // the 18th; the server's UTC date is still the 17th.
  await answerOdooQuestion(matchOdooQuestion("شو منتهي الصلاحية"), { odoo, fetcher }, Date.UTC(2026, 8, 17, 21, 30));
  assert.equal(expired, "2026-09-18");
});

// Basim (2026-09-17): the branches run three shifts -- 08:00-16:00, 16:00-24:00
// and 00:00-08:00, Amman time. Odoo stores date_order in UTC, so every boundary
// is the local hour minus three, and a report that forgets that is wrong by
// three hours while looking entirely right.
test("the three shifts are asked for in UTC, at the right boundaries", async () => {
  const windows = [];
  const { fetcher } = fetcherFor({ "pos.order": (args) => {
    const from = args[0].find(leaf => leaf[0] === "date_order" && leaf[1] === ">=")[2];
    const to = args[0].find(leaf => leaf[0] === "date_order" && leaf[1] === "<")[2];
    windows.push(`${from.slice(11, 16)}-${to.slice(11, 16)}`);
    return [{ location_id: [1, "NAOOR/Stock"], amount_total: 100, __count: 4 }];
  } });
  // 2026-09-17 12:00 Amman -> yesterday is the 16th.
  await answerOdooQuestion(matchOdooQuestion("شفتات امبارح"), { odoo, fetcher }, AT);
  assert.deepEqual(windows.sort(), ["05:00-13:00", "13:00-21:00", "21:00-05:00"].sort(),
    "08:00 in the pharmacy is 05:00 in the database");
});

test("each shift is named, given its share, and the day it belongs to is stated", async () => {
  const byShift = { "05:00": 600, "13:00": 300, "21:00": 100 };
  const { fetcher } = fetcherFor({ "pos.order": (args) => {
    const from = args[0].find(leaf => leaf[0] === "date_order" && leaf[1] === ">=")[2];
    return [{ location_id: [1, "NAOOR/Stock"], amount_total: byShift[from.slice(11, 16)], __count: 10 }];
  } });
  const reply = await answerOdooQuestion(matchOdooQuestion("شفتات امبارح"), { odoo, fetcher, currencyLabel: "دينار" }, AT);
  assert.match(reply, /شفتات \*?أمس/);
  assert.match(reply, /2026-09-16/);
  assert.match(reply, /☀️ صبح ٨–٤ — 600\.00 دينار \(60\.0%\)/);
  assert.match(reply, /🌆 مسا ٤–١٢ — 300\.00 دينار \(30\.0%\)/);
  assert.match(reply, /🌙 ليل ١٢–٨ — 100\.00 دينار \(10\.0%\)/);
  assert.match(reply, /الإجمالي\*: 1,000\.00 دينار من 30 عملية/);
});

test("a shift question about one branch counts only that branch", async () => {
  const { fetcher } = fetcherFor({ "pos.order": () => [
    { location_id: [1, "NAOOR/Stock"], amount_total: 900, __count: 9 },
    { location_id: [2, "SAFOT/Stock"], amount_total: 100, __count: 1 },
  ] });
  const match = matchOdooQuestion("شفتات صافوط امبارح");
  assert.equal(match.branch, "SAFOT");
  const reply = await answerOdooQuestion(match, { odoo, fetcher }, AT);
  assert.match(reply, /صافوط/);
  assert.match(reply, /الإجمالي\*: 300\.00 من 3 عملية/, "three shifts of 100 each, Naoor excluded");
});

// Today's night shift has already happened and the evening one has not, so a
// small morning figure would otherwise read as a bad night.
test("today's shifts say how far into the day the numbers go", async () => {
  const { fetcher } = fetcherFor({ "pos.order": () => [{ location_id: [1, "NAOOR/Stock"], amount_total: 50, __count: 2 }] });
  const reply = await answerOdooQuestion(matchOdooQuestion("شو الشفتات اليوم"), { odoo, fetcher }, AT);
  assert.match(reply, /شفتات \*?اليوم/);
  assert.match(reply, /لحد الساعة 12:00/);
});

test("a shift question is read as one even though it carries the word for sales", () => {
  assert.equal(matchOdooQuestion("مبيعات الشفتات امبارح")?.kind, "shifts_yesterday");
  assert.equal(matchOdooQuestion("شو مبيعات امبارح")?.kind, "sales_yesterday");
  assert.equal(matchOdooQuestion("شفت المسا بالناعور")?.kind, "shifts_today");
  assert.equal(matchOdooQuestion("وردية الليل")?.kind, "shifts_today");
});

test("a day with no sales in any shift says so instead of three zeroes", async () => {
  const { fetcher } = fetcherFor({ "pos.order": () => [] });
  const reply = await answerOdooQuestion(matchOdooQuestion("شفتات امبارح"), { odoo, fetcher }, AT);
  assert.match(reply, /ما في مبيعات مسجّلة/);
});
