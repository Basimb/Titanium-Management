// Basim asked to be able to ask the secretary about the pharmacy system live
// ("اسأله لايف ويجاوب") on the same night he had finished taking the model out
// of every tap decision. So the matching is written out by hand here and
// tested by hand: a question either lands on exactly one query, or on none at
// all. A wrong number would be worse than no answer, because he acts on it.
import test from "node:test";
import assert from "node:assert/strict";
import { matchOdooQuestion, answerOdooQuestion, normalizeArabic } from "../lib/odoo-questions.ts";

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
