// Basim, 2026-09-20, opening an audit of the pharmacy's Odoo: "بدنا نحلل منصه
// اودو تبعت الصيدليه ونشوف وين الاخطاء" -- and then, about the same check:
// "وخلي هذا الملف كمان نربطو بالسكرتير يستفيد منو". So the catalogue audit is
// a live question anyone can ask the bot, answered from counts, never guessed.
import test from "node:test";
import assert from "node:assert/strict";
import { matchOdooQuestion, answerOdooQuestion, forgetOdooAnswers } from "../lib/odoo-questions.ts";
import { openOdooSession, forgetOdooSessions } from "../lib/odoo-client.ts";

test.beforeEach(() => { forgetOdooAnswers(); forgetOdooSessions(); });

const odoo = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@x.com", apiKey: "k" };
const AT = Date.UTC(2026, 8, 20, 9, 0);

// One catalogue, answered consistently by both the counts and the groupings.
function pharmacy({ total = 4000, noBarcode = 800, noReference = 120, noCost = 300, noPrice = 40,
  zeroStock = 2600, negativeStock = 12, names = [["بنادول اكسترا", 3], ["فيتامين د", 2]], barcodes = [] } = {}) {
  const calls = [];
  const has = (domain, field, op, value) => domain.some(leaf =>
    Array.isArray(leaf) && leaf[0] === field && leaf[1] === op && leaf[2] === value);
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
    const [, , , model, method, args, kwargs] = body.params.args;
    calls.push({ model, method, domain: args[0], kwargs });
    const domain = args[0];
    let result = [];
    if (method === "search_count") {
      result = has(domain, "barcode", "=", false) ? noBarcode
        : has(domain, "default_code", "=", false) ? noReference
        : has(domain, "standard_price", "=", 0) ? noCost
        : has(domain, "list_price", "=", 0) ? noPrice
        : has(domain, "qty_available", "=", 0) ? zeroStock
        : has(domain, "qty_available", "<", 0) ? negativeStock
        : total;
    } else if (method === "read_group") {
      const field = args[2][0];
      const rows = field === "name" ? names : barcodes;
      result = rows.map(([value, count]) => ({ [field]: value, __count: count }));
    }
    return { ok: true, json: async () => ({ result }) };
  };
  return { fetcher, calls };
}

const ask = (text, pharmacyArg) => answerOdooQuestion(matchOdooQuestion(text), { odoo, currencyLabel: "دينار", fetcher: pharmacyArg.fetcher }, AT);

test("the wordings a person actually uses reach the catalogue check, not the stock one", () => {
  for (const text of ["فحص الأصناف", "نظافة البيانات", "أصناف مكررة", "مين بدون باركود", "في بيانات ناقصة؟", "مخزون سالب"]) {
    assert.equal(matchOdooQuestion(text)?.kind, "data_quality", text);
  }
  // The neighbouring question must not be swallowed: a shortage is still a shortage.
  assert.equal(matchOdooQuestion("شو ناقص من المخزون")?.kind, "low_stock");
  assert.equal(matchOdooQuestion("النواقص")?.kind, "low_stock");
});

test("the answer counts what is broken, as a share of the live catalogue", async () => {
  const shop = pharmacy();
  const reply = await ask("فحص الأصناف", shop);
  assert.match(reply, /4,000 صنف فعّال/);
  assert.match(reply, /بدون باركود: \*800\* \(20%\)/);
  assert.match(reply, /بدون سعر تكلفة: \*300\* \(8%\)/);
  assert.match(reply, /مخزون بالسالب: \*12\*/);
  assert.match(reply, /أسماء مكررة: \*2\* اسم على 5 صنف/);
  assert.match(reply, /بنادول اكسترا ×3/);
  // Zero stock is context at the end, never counted among the faults.
  assert.match(reply, /2,600 صنف رصيدها صفر \(65%\) — مش بالضرورة خطأ/);
  assert.doesNotMatch(reply, /NaN|undefined|Infinity/);
});

test("a clean line is left out rather than printed as a zero", async () => {
  const shop = pharmacy({ noBarcode: 0, noReference: 0, noPrice: 0, negativeStock: 0, names: [], barcodes: [] });
  const reply = await ask("نظافة البيانات", shop);
  assert.doesNotMatch(reply, /بدون باركود/);
  assert.doesNotMatch(reply, /أسماء مكررة/);
  assert.match(reply, /بدون سعر تكلفة/, "what IS broken still shows");
});

test("a spotless catalogue says so plainly, and an empty one does not divide by zero", async () => {
  const clean = pharmacy({ noBarcode: 0, noReference: 0, noCost: 0, noPrice: 0, negativeStock: 0, names: [], barcodes: [] });
  assert.match(await ask("فحص الأصناف", clean), /ما لقيت نواقص بالبيانات/);
  // The one-minute answer cache is keyed by question and day, not by which
  // catalogue answered it, so a second catalogue inside one test needs it clear.
  forgetOdooAnswers();
  const empty = pharmacy({ total: 0, noBarcode: 0, noReference: 0, noCost: 0, noPrice: 0, zeroStock: 0, negativeStock: 0, names: [], barcodes: [] });
  const reply = await ask("فحص الأصناف", empty);
  assert.match(reply, /ما لقيت أصناف فعّالة/);
  assert.doesNotMatch(reply, /NaN|Infinity/);
});

test("every read is scoped to saleable, active products and nothing writes", async () => {
  const shop = pharmacy();
  await ask("فحص الأصناف", shop);
  assert.ok(shop.calls.length >= 9, "each figure is its own counted read");
  for (const call of shop.calls) {
    assert.equal(call.model, "product.product");
    assert.ok(["search_count", "read_group"].includes(call.method), call.method);
    assert.ok(call.domain.some(leaf => leaf[0] === "sale_ok"), "archived catalogue never inflates the count");
    assert.ok(call.domain.some(leaf => leaf[0] === "active"));
  }
  // The duplicate grouping must not be truncated: a short page hides duplicates.
  const grouped = shop.calls.filter(call => call.method === "read_group");
  assert.equal(grouped.length, 2);
  for (const call of grouped) assert.ok(call.kwargs.limit >= 80_000, String(call.kwargs.limit));
});

test("a session refusing the read fails loudly instead of reporting a clean catalogue", async () => {
  const session = await openOdooSession(odoo, async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
    return { ok: true, json: async () => ({ error: { code: 200, data: { message: "AccessError" } } }) };
  });
  await assert.rejects(session.dataQuality(), error => error.name === "OdooError");
});
