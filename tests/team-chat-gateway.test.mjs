import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { handleTeamChatRequest, teamChatConfigFromEnv, signTeamChatBody, verifyTeamChatSignature } from "../lib/team-chat-gateway.ts";

const key = "ab".repeat(32); // Synthetic test key only.
const now = 1_789_000_000_000;
const timestamp = String(now);
const configuration = { enabled: true, sharedKey: key, contacts: [{ userId: "tester", number: "12025550101" }], allowedGroupIds: [] };
const base = { messageId: "TEST-MESSAGE", senderNumber: "12025550101", groupId: null, text: "شو علي", receivedAt: now };
function request(body = base, options = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://management.example.test/api/whatsapp/team-chat", {
    method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-titanium-chat-timestamp": timestamp, "x-titanium-chat-signature": signTeamChatBody(raw, timestamp, key), ...options.headers },
  });
}
const mustNotOpen = () => { throw new Error("Database must not be opened"); };

test("signature binds exact body, timestamp and secret", () => {
  const r = request(); const raw = JSON.stringify(base);
  assert.equal(verifyTeamChatSignature(raw, r.headers, key, now), true);
  assert.equal(verifyTeamChatSignature(raw + " ", r.headers, key, now), false);
  assert.equal(verifyTeamChatSignature(raw, r.headers, "cd".repeat(32), now), false);
  assert.equal(verifyTeamChatSignature(raw, r.headers, key, now + 300_001), false);
  assert.equal(verifyTeamChatSignature(raw, r.headers, key, now - 300_001), false);
  assert.equal(verifyTeamChatSignature(raw, new Headers({ "x-titanium-chat-signature": "bad" }), key, now), false);
});

test("configuration fails closed, private contacts explicit, groups empty by default", () => {
  assert.equal(teamChatConfigFromEnv({}).enabled, false);
  const env = { TEAM_CHAT_ENABLED: "1", TEAM_CHAT_SHARED_KEY: key, TEAM_CHAT_CONTACTS_JSON: JSON.stringify(configuration.contacts) };
  assert.deepEqual(teamChatConfigFromEnv(env), configuration);
  for (const override of [
    { TEAM_CHAT_SHARED_KEY: "short" }, { TEAM_CHAT_CONTACTS_JSON: "not-json" },
    { TEAM_CHAT_CONTACTS_JSON: "[]" }, { TEAM_CHAT_GROUP_IDS_JSON: '["some group name"]' },
    { TEAM_CHAT_CONTACTS_JSON: JSON.stringify([...configuration.contacts, ...configuration.contacts]) },
    { TEAM_CHAT_CONTACTS_JSON: JSON.stringify([{ userId: "tester", number: "I am 12025550101" }]) },
  ]) assert.equal(teamChatConfigFromEnv({ ...env, ...override }).enabled, false);
});

test("disabled gateway never opens database or calls the secretary", async () => {
  const r = await handleTeamChatRequest(request(), { config: { ...configuration, enabled: false }, getDatabase: mustNotOpen });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
});

test("forged signatures and stale requests do not reach database", async () => {
  for (const headers of [{ "x-titanium-chat-signature": "00".repeat(32) }, { "x-titanium-chat-timestamp": "123" }]) {
    const r = await handleTeamChatRequest(request(base, { headers }), { config: configuration, getDatabase: mustNotOpen, now: () => now });
    assert.equal(r.status, 401);
  }
});

test("malformed and oversized signed messages are rejected before database", async () => {
  for (const body of ["{", "x".repeat(17_000), { ...base, actorId: "basem" }, { ...base, groupId: "fake" }, { ...base, senderNumber: "@lid" }, { ...base, text: "x".repeat(2001) }, { ...base, receivedAt: "today" }, { ...base, messageId: "" }]) {
    const r = await handleTeamChatRequest(request(body), { config: configuration, getDatabase: mustNotOpen, now: () => now });
    assert.equal(r.status, 400);
  }
});

test("unknown content type and methods cannot create writes", async () => {
  const r = await handleTeamChatRequest(request(base, { headers: { "content-type": "text/plain" } }), { config: configuration, getDatabase: mustNotOpen });
  assert.equal(r.status, 415);
  const get = await handleTeamChatRequest(new Request("https://management.example.test"), { config: configuration, getDatabase: mustNotOpen });
  assert.equal(get.status, 405);
});

test("signed choices reject malformed, mixed-media, quoted and group payloads before DB access", async () => {
  const choice = { questionId: "Q_fixture", optionId: "O_fixture" };
  const secretary = async () => { throw Error("must not call secretary"); };
  for (const override of [
    { choice: null }, { choice: [] }, { choice: "bad" }, { choice: {} },
    { choice: { ...choice, actorId: "basem" } }, { choice: { questionId: "Q_fixture" } },
    { choice: { ...choice, optionId: "x".repeat(101) } }, { choice: { ...choice, optionId: "../x" } },
    { choice: { ...choice, questionId: 123 } }, { choice, inputKind: "voice" },
    { choice, replyToMessageId: "old-preview" }, { choice, groupId: "120363555000@g.us" },
  ]) {
    const result = await handleTeamChatRequest(request({ ...base, ...override }), {
      config: configuration, getDatabase: mustNotOpen, now: () => now, secretary,
    });
    assert.equal(result.status, 400);
  }
});

test("a choice cannot be processed without an active secretary -- there is no older parser to fall back to", async () => {
  const result = await handleTeamChatRequest(request({ ...base, choice: { questionId: "Q_fixture", optionId: "O_fixture" } }), {
    config: configuration, getDatabase: mustNotOpen, now: () => now,
  });
  assert.equal(result.status, 503);
});

// Gateway-level dispatch: actor authentication, message freshness and error
// sanitization, exercised against a stub secretary. secretary-service.test.mjs
// and secretary-choices-gateway.test.mjs cover the secretary's own behavior.
let integrationSequence = 0;
function gatewayFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL);
    INSERT INTO users VALUES ('tester','موظف تجريبي','member',1);`);
  // Quotas are process-scoped, so use distinct minutes for independent tests.
  const clock = now + (++integrationSequence * 60_000);
  const makeRequest = (overrides = {}) => {
    const body = { ...base, receivedAt: clock, ...overrides };
    const raw = JSON.stringify(body);
    const stamp = String(clock);
    return new Request("https://management.example.test/api/whatsapp/team-chat", {
      method: "POST", body: raw, headers: {
        "content-type": "application/json", "x-titanium-chat-timestamp": stamp,
        "x-titanium-chat-signature": signTeamChatBody(raw, stamp, key),
      },
    });
  };
  const run = (overrides = {}, secretary = async () => ({ status: "applied", reply: "" })) =>
    handleTeamChatRequest(makeRequest(overrides), { config: configuration, getDatabase: () => sqlite, now: () => clock, secretary });
  return { sqlite, clock, run };
}

test("authenticated private choice reaches only the secretary with exact IDs and forwards options", async t => {
  const f = gatewayFixture(t);
  const choice = { questionId: "Q_fixture", optionId: "O_fixture" };
  const choices = { id: "Q_next", title: "شو أولويتها؟", options: [{ id: "O_red", label: "قصوى" }, { id: "O_green", label: "عادية" }], expiresAt: f.clock + 60000 };
  let calls = 0;
  const result = await f.run({ text: "اختيار تجريبي", choice, inputKind: "text" }, async (sqlite, event) => {
    calls++;
    assert.equal(sqlite, f.sqlite);
    assert.deepEqual(event.choice, choice);
    assert.equal(event.senderNumber, configuration.contacts[0].number);
    return { status: "clarify", reply: "شو أولويتها؟", choices };
  });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).choices, choices);
  assert.equal(calls, 1);
  f.sqlite.exec("UPDATE users SET active=0 WHERE id='tester'");
  const denied = await f.run({ messageId: "choice-2", choice }, mustNotOpen);
  assert.equal(denied.status, 403);
});

test("unknown sender, unapproved group and a disabled actor never reach the secretary", async t => {
  const f = gatewayFixture(t);
  for (const event of [{ senderNumber: "12025550999" }, { groupId: "120363555000@g.us" }]) {
    assert.equal((await f.run(event, mustNotOpen)).status, 403);
  }
  f.sqlite.exec("UPDATE users SET active=0 WHERE id='tester'");
  assert.equal((await f.run({}, mustNotOpen)).status, 403);
});

test("old or future messages are rejected before the secretary is called", async t => {
  const f = gatewayFixture(t);
  for (const receivedAt of [f.clock - 600_001, f.clock + 60_001]) {
    assert.equal((await f.run({ receivedAt }, mustNotOpen)).status, 400);
  }
});

test("an unexpected secretary failure returns a sanitized 503 with no internal detail leaked", async t => {
  const f = gatewayFixture(t);
  const r = await f.run({}, async () => { throw new Error("secret-key-production-path-employee-message"); });
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(await r.json()), /secret-key|production-path|employee-message/);
});

test("provider failures expose only safe codes and preserve retry timing", async t => {
  const {SecretaryProviderError}=await import('../lib/secretary-intent.ts');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE users(id TEXT,name TEXT,role TEXT,active INTEGER); INSERT INTO users VALUES('tester','Test','member',1)");
  for(const [error,status,wait] of [[new SecretaryProviderError('rate_limited',41),503,'41'],[new SecretaryProviderError('invalid_plan'),200,null]]){
    const r=await handleTeamChatRequest(request(),{config:configuration,getDatabase:()=>db,now:()=>now+60000,secretary:async()=>{throw error}});
    assert.equal(r.status,status);assert.equal(r.headers.get('retry-after'),wait);
    const body=await r.text();assert.doesNotMatch(body,/gsk_|fields|json_validate|stack/);
  }
});
