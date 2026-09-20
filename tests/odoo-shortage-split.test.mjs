// Basim and Shadi, 2026-09-20, reading a shortage alert together:
// "بشتغل عالتجزئه" / "بقرا صح بس عستوك التجزئه".
//
// A medicine is kept as two product records that share a barcode: the pack,
// and the تجزئة split that sells loose pieces out of it. Counted apart, the
// split is forever "13 pieces left at 252 a day" while a shelf of packs sits
// behind it — so the alert fires on a shortage that does not exist. The live
// system had 48 such alerts; 32 of them were this.
import test from "node:test";
import assert from "node:assert/strict";
import { openOdooSession, forgetOdooSessions } from "../lib/odoo-client.ts";

test.beforeEach(() => { forgetOdooSessions(); });
const config = { url: "https://pharmacy.example.com", db: "pharmacy", username: "bot@x.com", apiKey: "k" };

// products: [id, name, barcode, onHand, cost] · sales: { id: qtyIn60Days }
function pharmacy(products, sales) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.params.service === "common") return { ok: true, json: async () => ({ result: 1 }) };
    const [, , , model, method, args, kwargs] = body.params.args;
    const offset = kwargs.offset || 0;
    let result = [];
    if (model === "pos.order.line" && method === "read_group") {
      result = offset ? [] : Object.entries(sales).map(([id, qty]) => ({ product_id: [Number(id), "p" + id], qty, __count: 1 }));
    } else if (model === "product.product" && method === "search_read") {
      result = offset ? [] : products.map(([id, name, barcode, onHand, cost]) =>
        ({ id, name, barcode, qty_available: onHand, standard_price: cost }));
    // One branch, so the per-branch reckoning sees exactly the same shelf the
    // company-wide one does and these cases stay comparable.
    } else if (model === "pos.config" && method === "search_read") {
      result = offset ? [] : [{ id: 1, name: "Naoor POS", picking_type_id: [10, "Naoor: PoS Orders"] }];
    } else if (model === "stock.picking.type" && method === "search_read") {
      result = offset ? [] : [{ id: 10, default_location_src_id: [8, "NAOOR/Stock"] }];
    } else if (model === "stock.quant" && method === "read_group") {
      result = offset ? [] : products.map(([id, name, , onHand]) => ({ product_id: [id, name], quantity: onHand, __count: 1 }));
    }
    return { ok: true, json: async () => ({ result }) };
  };
}
const shortagesOf = async (products, sales) => {
  const session = await openOdooSession(config, pharmacy(products, sales));
  return session.shortages({ windowDays: 60, maxDaysLeft: 7, limit: 20 });
};

test("a pack and its split share one barcode, so their stock is counted once, together", async () => {
  // 40 packs at 3.92 on the shelf, plus 37 loose sachets at 0.131.
  // The split alone reads 1.3 days of cover; the medicine really has ~30.
  const items = await shortagesOf(
    [[1, "VOLTFAST 30 SACHETS (Pack)", "600123", 40, 3.92], [2, "VOLTFAST 30 SACHETS (تجزئة)", "600123", 37, 0.131]],
    { 2: 1704 });
  assert.deepEqual(items, [], "a shelf of packs is not a shortage");
});

test("the same medicine still raises the alarm once the packs are gone too", async () => {
  const items = await shortagesOf(
    [[1, "VOLTFAST 30 SACHETS (Pack)", "600123", 0, 3.92], [2, "VOLTFAST 30 SACHETS (تجزئة)", "600123", 37, 0.131]],
    { 2: 1704 });
  assert.equal(items.length, 1);
  assert.ok(items[0].daysLeft < 2, `days left ${items[0].daysLeft}`);
  assert.match(items[0].name, /VOLTFAST/);
  // With the packs at zero there is only one record left holding stock, so
  // the piece count means something again and the message keeps it.
  assert.equal(items[0].combined, false);
  assert.equal(items[0].qty, 37);
});

test("an ordinary product is measured exactly as before -- cost cancels out", async () => {
  const withCost = await shortagesOf([[1, "PANADOL", "600999", 12, 0.758]], { 1: 240 });
  const noCost = await shortagesOf([[1, "PANADOL", "600999", 12, 0]], { 1: 240 });
  assert.equal(withCost.length, 1);
  assert.equal(withCost[0].combined, false);
  assert.equal(Math.round(withCost[0].daysLeft * 100), 300, "12 on hand at 4/day = 3 days");
  assert.equal(Math.round(noCost[0].daysLeft * 100), 300, "and the same when there is no cost to measure with");
  assert.equal(withCost[0].qty, 12);
});

test("a group where one record has no cost falls back to counting pieces rather than dropping out", async () => {
  const items = await shortagesOf(
    [[1, "SYRINGE (Pack)", "500111", 1, 0], [2, "SYRINGE (تجزئة)", "500111", 13, 0.001]],
    { 2: 600 });
  assert.equal(items.length, 1, "it must still be reported, not silently lost");
  assert.equal(items[0].combined, true);
  assert.equal(Math.round(items[0].daysLeft * 10) / 10, 1.4, "14 pieces on hand at 10 a day");
});

test("stock that never sold is never a shortage, however little of it there is", async () => {
  const items = await shortagesOf([[1, "DEAD ITEM", "600777", 1, 5]], {});
  assert.deepEqual(items, []);
});

test("a net-refunded product cannot produce negative days", async () => {
  const items = await shortagesOf([[1, "RETURNED", "600555", 11, 2]], { 1: -30 });
  assert.deepEqual(items, [], "negative movement is not consumption");
});

// Basim, 2026-09-21, reading the alert on his phone: "هيو انا عربي كيف اقرا
// هذا خليه اوضح". Every product name is English and every measurement is
// Arabic; on one line WhatsApp's bidi rules put the dash in the middle and
// throw the numbers around. One line each, numbered so he can point at one.
test("the name and the measurement never share a line", async () => {
  const { matchOdooQuestion, answerOdooQuestion, forgetOdooAnswers } = await import("../lib/odoo-questions.ts");
  forgetOdooAnswers();
  const reply = await answerOdooQuestion(matchOdooQuestion("شو ناقص من المخزون"),
    { odoo: config, currencyLabel: "دينار",
      fetcher: pharmacy([[1, "PANTENE PRO-V OIL REPLACEMENT 275 ML", "600321", 1, 2],
        [2, "SYRINGE (Pack)", "500111", 1, 1], [3, "SYRINGE (تجزئة)", "500111", 5, 0.1]],
        { 1: 300, 3: 600 }) }, Date.now());
  const lines = reply.split("\n");
  const named = lines.findIndex(line => line.includes("PANTENE"));
  assert.ok(named > 0, reply);
  assert.match(lines[named], /^\*\d+\.\* PANTENE/, "the English name stands alone on its line");
  assert.doesNotMatch(lines[named], /المتوفر|علبة/, "no Arabic beside it");
  assert.match(lines[named + 1], /^المتوفر: \*1\*$/, "the Arabic measurement stands alone too");
  // Basim, 2026-09-20: "شيل قصة التجزئه اعرض علبه حتى لو بالاعشار". The merged
  // pack+split is one and a half packs -- five loose pieces at a tenth of the
  // pack's cost is half a pack -- not "1 pack and 5 pieces".
  const split = lines.findIndex(line => line.includes("SYRINGE"));
  assert.match(lines[split + 1], /^المتوفر: \*1\.5\*$/);
  assert.doesNotMatch(lines[split + 1], /قطعة|تجزئة/);
});
