// باسم 06/11/2026: Claude رد بكلام عادي بدل أداة («مجاز اليوم») ← الكلام بيرجع للموظف بدل رد الخلل.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferSecretaryIntent } from '../lib/secretary-intent.ts';

test('a plain text answer with no tool call becomes a conversational reply', async () => {
  const fetcher = async () => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'تمام، يومك سعيد 🌿 وبلّغ أيمن إذا بدك تسجّلها.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const input = { text: 'مجاز اليوم', actor: { id: 'u1', name: 'موظف', role: 'member' }, history: [], members: [], tasks: [], now: Date.now(), canNotifyOwner: true };
  const plan = await inferSecretaryIntent(input, { apiKey: 'k', model: 'm', fetcher });
  assert.equal(plan.kind, 'clarify');
  assert.match(plan.message, /يومك سعيد/);
});
