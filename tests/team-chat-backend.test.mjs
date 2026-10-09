// Basim, 2026-10-09: "الغي الموقع تماما". The secretary's backend answers
// inside the bridge now, so this is the bridge's exact signed POST, handed to
// the backend in-process -- same settings file, same database, no website.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { signTeamChatBody } from "../lib/team-chat-gateway.ts";

const key = "ab".repeat(32); // Synthetic test key only.
const prefix = path.join(tmpdir(), "titanium-backend-");
const directory = mkdtempSync(prefix);
const settingsPath = path.join(directory, "settings.json");
writeFileSync(settingsPath, JSON.stringify({
  TEAM_CHAT_ENABLED: "1", TEAM_CHAT_SHARED_KEY: key, SECRETARY_ENABLED: "1",
  TEAM_CHAT_CONTACTS_JSON: JSON.stringify([{ userId: "basem", number: "12025550101" }, { userId: "stranger", number: "12025550199" }]),
  TEAM_CHAT_GROUP_IDS_JSON: "[]",
}), { mode: 0o600 });
// The two names the bridge sets before loading the backend (main.mjs).
process.env.TITANIUM_TEAM_CHAT_CONFIG = settingsPath;
process.env.TITANIUM_DATA_DIR = path.join(directory, "data");
const { localTeamChatFetcher } = await import("../lib/team-chat-backend.ts");
test.after(() => { assert.ok(directory.startsWith(prefix) && directory !== prefix); rmSync(directory, { recursive: true, force: true }); });

const URL = "https://management.example.test/api/whatsapp/team-chat";
function signedPost(body, signingKey = key) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  return { method: "POST", body: raw, redirect: "error", signal: AbortSignal.timeout(80_000),
    headers: { "content-type": "application/json", "x-titanium-chat-timestamp": timestamp, "x-titanium-chat-signature": signTeamChatBody(raw, timestamp, signingKey) } };
}
const tap = (senderNumber, n = 1) => ({ messageId: `MSG-${n}`, senderNumber, groupId: null, text: "4", receivedAt: Date.now(),
  responseMessageId: `REPLY-${n}`, choice: { questionId: "LGDQ", optionId: "LGDEXTEND" } });

test("the bridge's signed POST is answered in-process from the settings file and the database", async () => {
  const fetcher = localTeamChatFetcher();
  const response = await fetcher(URL, signedPost(tap("12025550101")));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(typeof result.status, "string");
  assert.equal(typeof result.reply, "string");
  assert.ok(result.reply.length > 0, "a real reply, not an empty one");
  // The members the bridge may message were seeded here, with no website to do it.
  const users = new DatabaseSync(path.join(directory, "data", "titanium.sqlite"), { readOnly: true });
  try {
    const ids = users.prepare("SELECT id FROM users WHERE active=1 ORDER BY id").all().map(row => row.id);
    assert.deepEqual(ids, ["ayman", "basem", "khaled", "mohammad-eyad", "shadi"]);
  } finally { users.close(); }
});

test("the same checks as over the wire: a wrong key is refused, an unknown number is denied", async () => {
  const fetcher = localTeamChatFetcher();
  assert.equal((await fetcher(URL, signedPost(tap("12025550101", 2), "cd".repeat(32)))).status, 401);
  assert.equal((await fetcher(URL, signedPost(tap("12025550199", 3)))).status, 403, "a contact with no active user row");
});
