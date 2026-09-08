import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContactNumber, resolveChatUser } from "../lib/team-chat-policy.ts";

const member = { id: "test-member", name: "موظف تجريبي", role: "member", active: 1 };
const contacts = [{ userId: member.id, number: "+1 202 555 0101" }];

test("recognizes formatted trusted numbers, never digits inside arbitrary text", () => {
  assert.equal(normalizeContactNumber("001 (202) 555-0101"), "12025550101");
  assert.equal(normalizeContactNumber("انا باسم 12025550101"), null);
  assert.equal(normalizeContactNumber("123"), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, contacts, [member])?.id, member.id);
});

test("unknown, inactive and duplicate contacts cannot act", () => {
  assert.equal(resolveChatUser({ senderNumber: "12025550102" }, contacts, [member]), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, contacts, [{ ...member, active: 0 }]), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, [...contacts, ...contacts], [member]), null);
});

test("group messages are denied by default and require exact group allow-list", () => {
  const origin = { senderNumber: "12025550101", groupId: "test-group" };
  assert.equal(resolveChatUser(origin, contacts, [member]), null);
  assert.equal(resolveChatUser(origin, contacts, [member], ["different-group"]), null);
  assert.equal(resolveChatUser(origin, contacts, [member], ["test-group"])?.id, member.id);
  assert.equal(resolveChatUser({ ...origin, groupId: "" }, contacts, [member]), null);
});
