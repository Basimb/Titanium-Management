// باسم 04/11/2026 «بلش اه»: رد الموديل المش مرتب بينعاد مرة وحدة، وإذا فشل الرد ما بيلوم الموظف.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleTeamChatRequest, signTeamChatBody } from '../lib/team-chat-gateway.ts';
import { SecretaryProviderError } from '../lib/secretary-intent.ts';

function setup(t, secretary) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO users VALUES('basem','مدير','admin',1,NULL,1,1);`);
  const clock = 1788606000000, key = 'cd'.repeat(32), number = '12025550901';
  const config = { enabled: true, sharedKey: key, contacts: [{ userId: 'basem', number }], allowedGroupIds: [] };
  return async () => {
    const raw = JSON.stringify({ messageId: 'M-1', responseMessageId: 'R-1', senderNumber: number, groupId: null, text: 'مرحبا', receivedAt: clock });
    const request = new Request('https://example.test/x', { method: 'POST', body: raw, headers: { 'content-type': 'application/json',
      'x-titanium-chat-timestamp': String(clock), 'x-titanium-chat-signature': signTeamChatBody(raw, String(clock), key) } });
    const response = await handleTeamChatRequest(request, { config, getDatabase: () => db, now: () => clock, secretary });
    return { status: response.status, body: await response.json() };
  };
}

test('one invalid_plan is retried and the second answer is used', async t => {
  let calls = 0;
  const send = setup(t, async () => { calls++; if (calls === 1) throw new SecretaryProviderError('invalid_plan'); return { status: 'summary', reply: 'هلا' }; });
  const r = await send();
  assert.equal(calls, 2);
  assert.equal(r.body.reply, 'هلا');
});

test('two failures give an honest reply that does not blame the employee', async t => {
  let calls = 0;
  const send = setup(t, async () => { calls++; throw new SecretaryProviderError('invalid_plan'); });
  const r = await send();
  assert.equal(calls, 2);
  assert.doesNotMatch(r.body.reply, /وضّح المطلوب/);
  assert.match(r.body.reply, /الغلط مني/);
});

test('a transport failure with retry-after is not retried in place', async t => {
  let calls = 0;
  const send = setup(t, async () => { calls++; throw new SecretaryProviderError('provider_transport', 30); });
  const r = await send();
  assert.equal(calls, 1);
  assert.equal(r.status, 503);
});
