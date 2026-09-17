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

test("low stock lists the items under the threshold", async () => {
  const { fetcher, calls } = fetcherFor({ "product.product": () => [{ name: "بانادول", qty_available: 2 }, { name: "فيتامين د", qty_available: 0 }] });
  const text = await answerOdooQuestion(matchOdooQuestion("شو ناقص"), { odoo, lowStockThreshold: 5, fetcher }, AT);
  assert.ok(calls[0].domain.some(c => c[0] === "qty_available" && c[2] === 5));
  assert.match(text, /بانادول — 2/);
  assert.match(text, /فيتامين د — 0/);
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
  const bills = await answerOdooQuestion(matchOdooQuestion("كم فاتورة مورد مش مدفوعة"), { odoo, fetcher }, AT);
  assert.match(bills, /فواتير موردين/);
  assert.equal(calls.length, 2);
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
