// The router is the one place the model touches the live-questions feature,
// and it is allowed to return exactly one thing: which report was asked for.
// Everything else it could possibly say -- a kind that does not exist, prose,
// a figure, an error -- has to come out as "not a question I route".
import test from "node:test";
import assert from "node:assert/strict";
import { classifyOdooQuestion } from "../lib/odoo-question-model.ts";

const options = (content, extra = {}) => ({
  apiKey: "synthetic-key-never-real",
  fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }),
  ...extra,
});

test("a routed question comes back as its kind and branch", async () => {
  const match = await classifyOdooQuestion("قديش صار عنا بدابوق هالشهر؟", options('{"kind":"sales_month","branch":"DABOQ"}'));
  assert.deepEqual(match, { kind: "sales_month", branch: "DABOQ" });
});

test("a question with no branch in it carries no branch", async () => {
  const match = await classifyOdooQuestion("شو الوضع بالمخزون", options('{"kind":"low_stock","branch":null}'));
  assert.deepEqual(match, { kind: "low_stock", branch: null });
});

test("a branch spelled in lower case is still the branch", async () => {
  const match = await classifyOdooQuestion("naoor sales", options('{"kind":"sales_today","branch":"naoor"}'));
  assert.deepEqual(match, { kind: "sales_today", branch: "NAOOR" });
});

test("anything that is not one of the known kinds routes nowhere", async () => {
  for (const content of ['{"kind":"none","branch":null}', '{"kind":"salaries","branch":null}',
    '{"kind":"sales_today"', "sure, that's a sales question!", '{"branch":"NAOOR"}', '["sales_today"]', '{"kind":42}']) {
    assert.equal(await classifyOdooQuestion("سؤال", options(content)), null, content);
  }
});

test("an invented branch is dropped, but the question it belongs to is kept", async () => {
  const match = await classifyOdooQuestion("مبيعات الجاردنز", options('{"kind":"sales_today","branch":"GARDENS"}'));
  assert.deepEqual(match, { kind: "sales_today", branch: null });
});

test("a provider that errors, refuses or hangs routes nowhere instead of throwing", async () => {
  const refused = { apiKey: "k", fetcher: async () => ({ ok: false, json: async () => ({}) }) };
  assert.equal(await classifyOdooQuestion("مبيعات اليوم", refused), null);
  const broken = { apiKey: "k", fetcher: async () => { throw new Error("network"); } };
  assert.equal(await classifyOdooQuestion("مبيعات اليوم", broken), null);
});

test("without a key, or with a message too long to be one of these questions, nothing is sent at all", async () => {
  let calls = 0;
  const counting = extra => ({ fetcher: async () => { calls += 1; return { ok: true, json: async () => ({}) }; }, ...extra });
  assert.equal(await classifyOdooQuestion("مبيعات اليوم", counting({})), null);
  assert.equal(await classifyOdooQuestion("م".repeat(201), counting({ apiKey: "k" })), null);
  assert.equal(await classifyOdooQuestion("   ", counting({ apiKey: "k" })), null);
  assert.equal(calls, 0);
});

test("only the message is sent -- no key material, catalog or history rides along", async () => {
  let body;
  await classifyOdooQuestion("مبيعات صافوط", {
    apiKey: "synthetic-key-never-real",
    fetcher: async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"kind":"sales_today","branch":"SAFOT"}' } }] }) }; },
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, "مبيعات صافوط");
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.max_completion_tokens <= 60, "a routing answer is a few tokens, never a paragraph");
  assert.doesNotMatch(JSON.stringify(body), /synthetic-key-never-real/);
});
