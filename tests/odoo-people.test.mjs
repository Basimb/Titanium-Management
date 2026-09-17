// Whose permissions a question runs under. Basim's answer to "who may ask?"
// was "everyone, each by their own permission, they have their own Odoo users"
// -- so the one thing that must never happen is somebody borrowing his.
import test from "node:test";
import assert from "node:assert/strict";
import { odooPersonFor } from "../lib/odoo-people.ts";

const base = { url: "https://pharmacy.example.com", db: "pharmacy" };
const keys = JSON.stringify({
  basem: { username: "basim@example.com", apiKey: "synthetic-basim-key" },
  khaled: { username: "khaled@example.com", apiKey: "synthetic-khaled-key" },
});

test("each person queries as themselves", () => {
  assert.equal(odooPersonFor("basem", base, keys).config.username, "basim@example.com");
  assert.equal(odooPersonFor("khaled", base, keys).config.apiKey, "synthetic-khaled-key");
});

test("a person with no key of their own gets nothing -- never the owner's session", () => {
  assert.equal(odooPersonFor("omar", base, keys), null);
  assert.equal(odooPersonFor("", base, keys), null);
  assert.equal(odooPersonFor("basem", base, undefined), null);
});

test("two people never share a cached login or a cached database map", () => {
  const basem = odooPersonFor("basem", base, keys);
  const khaled = odooPersonFor("khaled", base, keys);
  assert.notEqual(basem.cacheKey, khaled.cacheKey);
});

test("a malformed or oversized key list disables the feature rather than half-enabling it", () => {
  for (const value of ["{", "[]", '"basem"', "null", JSON.stringify({ basem: "key-only" }),
    JSON.stringify({ basem: { username: "x" } }), JSON.stringify({ basem: { username: "x", apiKey: "" } }),
    JSON.stringify({ basem: { username: "a\nb", apiKey: "k" } }), "{" + "x".repeat(8001)]) {
    assert.equal(odooPersonFor("basem", base, value), null, value.slice(0, 30));
  }
});

test("the server and database come from the shared settings, not from the person's entry", () => {
  const sneaky = JSON.stringify({ basem: { username: "u", apiKey: "k", url: "https://elsewhere.example.com", db: "other" } });
  const person = odooPersonFor("basem", base, sneaky);
  assert.equal(person.config.url, base.url);
  assert.equal(person.config.db, base.db);
});
