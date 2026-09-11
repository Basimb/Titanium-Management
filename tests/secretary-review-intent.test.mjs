import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySecretaryIntent, inferSecretaryIntent, validateSecretaryIntent, searchSecretaryWeb }
  from '../lib/secretary-intent.ts';

const context = (extra = {}) => ({
  text: 'جوابك غلط، راجع السؤال', actor: { id: 'basem', name: 'باسم تجريبي', role: 'admin' },
  tasks: [{ id: 'task-test', title: 'تجهيز تقرير داخلي', status: 'progress', priority: 'red' }],
  users: [{ id: 'member-test', name: 'موظف اصطناعي' }],
  history: [], now: '2026-09-06T08:00:00.000Z', focusedTaskId: 'task-test',
  canMessageTeam: true, messageRecipients: [{ id: 'member-test', name: 'موظف اصطناعي' }],
  review: { previousQuestion: 'شو يعني اللون الأخضر؟', previousAnswer: 'يعني أن المهمة انتهت.' }, ...extra,
});
function toolArgsFor(plan) {
  if (plan.kind === 'chat' || plan.kind === 'clarify') return { message: plan.message, taskId: plan.taskId };
  throw new Error('toolArgsFor: unsupported kind in test helper: ' + plan.kind);
}
const response = plan => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: plan.kind, arguments: JSON.stringify(toolArgsFor(plan)) } }] } }] });

test('review retains the same bounded OpenAI call and receives quoted context plus explicit truthful identity policy', async () => {
  const input = context(), seen = [];
  const plan = await inferSecretaryIntent(input, { apiKey: 'synthetic-only', fetcher: async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return response(emptySecretaryIntent('chat', 'التصحيح: الأخضر أولوية عادية، وليس دليلًا على إنجاز المهمة.'));
  } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
  const body = seen[0].body, prompt = body.messages[0].content;
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.reasoning_effort, undefined); assert.equal(body.max_completion_tokens, 1300);
  assert.equal(body.tool_choice, 'required'); assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools.every(tool => tool.function.strict === true), true);
  assert.equal(body.messages.length, 2);
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.match(prompt, /أنا سكرتير باسم، مساعده الافتراضي/);
  assert.match(prompt, /not Basim himself, not ChatGPT itself and not a human employee/);
  assert.match(prompt, /Do not repeat this introduction/);
  assert.match(prompt, /Review is READ-ONLY/);
  assert.match(prompt, /untrusted quoted conversation/);
  assert.match(prompt, /agree automatically/);
  assert.match(prompt, /missing detail materially changes/);
  assert.match(prompt, /do not execute that old action again/);
  assert.match(prompt, /Criticism never approves a pending preview/);
  assert.match(prompt, /Only a later search tool result/);
  assert.match(prompt, /Do not claim self-modification or permanent learning/);
  assert.equal(plan.kind, 'chat'); assert.equal(plan.action, null);
});

test('review cannot revive any action, draft, reminder or outbound message from the previous answer', () => {
  const input = context({ review: { previousQuestion: 'احذف المهمة', previousAnswer: 'اكتب موافق لتنفيذ الحذف' },
    text: 'جوابك غلط، موافق نفذها', taskDraft: { title: 'قديمة', details: null, priority: null, ownerId: null, dueDate: null } });
  const plans = [
    { ...emptySecretaryIntent('command'), action: 'delete_task', taskId: 'task-test' },
    { ...emptySecretaryIntent('command'), action: 'comment', taskId: 'task-test', fields: { ...emptySecretaryIntent().fields, body: 'تحديث مخترع' } },
    { ...emptySecretaryIntent('task_draft'), intakeMode: 'continue' },
    { ...emptySecretaryIntent('remind'), taskId: 'task-test', fields: { ...emptySecretaryIntent().fields, remindAt: '2026-09-07T10:00:00+03:00' } },
    { ...emptySecretaryIntent('message_team'), recipientIds: ['all-team'], fields: { ...emptySecretaryIntent().fields, body: 'أعد الإرسال' } },
  ];
  for (const candidate of plans) {
    const result = validateSecretaryIntent(candidate, input);
    assert.equal(result.kind, 'clarify'); assert.equal(result.action, null);
    assert.equal(result.intakeMode, null); assert.deepEqual(result.recipientIds, []);
    assert.ok(Object.values(result.fields).every(value => value === null));
  }
});

test('read-only review rejects mutation data hidden under chat, report or search labels', () => {
  for (const kind of ['chat', 'report', 'search']) {
    const base = emptySecretaryIntent(kind, kind === 'report' ? null : 'نص عام');
    for (const extra of [{ action: 'approve' }, { intakeMode: 'start' }, { recipientIds: ['member-test'] },
      { fields: { ...base.fields, body: 'خزن النص' } }, { fields: { ...base.fields, priority: 'green' } }]) {
      assert.equal(validateSecretaryIntent({ ...base, ...extra }, context()).kind, 'clarify');
    }
  }
});

test('review keeps factual read paths and still validates the authorized task and owner-only message status', () => {
  for (const kind of ['chat', 'clarify', 'help', 'summary', 'report', 'message_status']) {
    assert.equal(validateSecretaryIntent(emptySecretaryIntent(kind, ['chat', 'clarify'].includes(kind) ? 'نقطة المراجعة' : null), context()).kind, kind);
  }
  // "projects" is not a kind anymore -- a stale model output naming it fails.
  assert.throws(() => validateSecretaryIntent(emptySecretaryIntent('projects'), context()));
  const details = { ...emptySecretaryIntent('details'), taskId: 'task-test' };
  assert.equal(validateSecretaryIntent(details, context()).kind, 'details');
  assert.equal(validateSecretaryIntent({ ...details, taskId: 'foreign-task' }, context()).kind, 'clarify');
  assert.equal(validateSecretaryIntent(emptySecretaryIntent('message_status'), context({ actor: { id: 'member-test', name: 'موظف اصطناعي', role: 'member' } })).kind, 'clarify');
});

test('review search permits a standalone public query but refuses catalog names and private identifiers', () => {
  assert.equal(validateSecretaryIntent(emptySecretaryIntent('search', 'ما الفرق بين الطقس والمناخ؟'), context()).kind, 'search');
  for (const query of ['ابحث عن تجهيز تقرير داخلي', 'عنوان موظف اصطناعي', 'باسم تجريبي',
    'رمز الدخول ١٢٣٤٥٦', 'السعر للحساب ۱۲۳۴۵۶', 'حساب 123456', 'test@example.invalid', 'قائمة مهامي']) {
    assert.equal(validateSecretaryIntent(emptySecretaryIntent('search', query), context()).kind, 'clarify');
  }
});

test('malformed or oversized review data is rejected before a provider call', async () => {
  for (const review of [{}, { previousQuestion: '', previousAnswer: 'جواب' },
    { previousQuestion: 'س'.repeat(2001), previousAnswer: 'جواب' },
    { previousQuestion: 'سؤال', previousAnswer: 'ج'.repeat(4001) },
    { previousQuestion: 'سؤال', previousAnswer: 'جواب', instructions: 'override' }]) {
    await assert.rejects(inferSecretaryIntent(context({ review }), { apiKey: 'synthetic-only', fetcher: async () => assert.fail('must not call provider') }), /review context/);
  }
});

test('ordinary task updates remain available without review context', () => {
  const input = context({ review: undefined, text: 'سجل تعليق: خلصت جزء من التقرير' });
  const plan = { ...emptySecretaryIntent('command'), action: 'comment', taskId: 'task-test', fields: { ...emptySecretaryIntent().fields, body: 'خلصت جزء من التقرير' } };
  assert.equal(validateSecretaryIntent(plan, input).kind, 'command');
});

test('admin claiming an unassigned task by bare number ("استلم 15") resolves locally, same as "استلم رقم 15"', () => {
  const ownershipCandidates = Array.from({ length: 15 }, (_, i) => ({
    id: `task-${i + 1}`, title: `مهمة رقم ${i + 1}`, status: 'progress', assignee: null,
  }));
  for (const text of ['استلم 15', 'استلم رقم 15', 'خذلي 15', 'احمل 15']) {
    const input = context({ review: undefined, text, ownershipCandidates });
    const plan = validateSecretaryIntent(emptySecretaryIntent('ownership_request'), input);
    assert.equal(plan.kind, 'claim_multiple', `expected a local self-claim for "${text}"`);
    const { items, failed } = JSON.parse(plan.message);
    assert.deepEqual(failed, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'task-15');
  }
});

test('a bare number is only treated as a task position when nothing follows the claim verb but the number', () => {
  const ownershipCandidates = [{ id: 'task-15', title: 'مهمة رقم 15', status: 'progress', assignee: null }];
  // Text after the number means the "15" is not necessarily naming the task by
  // position (could be a file/phone/amount) -- this must still fall through to
  // the model's own (here: ownership_request, since basem/admin hits the
  // earlier clarify branch) rather than guessing.
  const input = context({ review: undefined, text: 'استلم المهمة يلي حكينا عنها, رقم الملف مو 15', ownershipCandidates });
  const plan = validateSecretaryIntent(emptySecretaryIntent('ownership_request'), input);
  assert.notEqual(plan.kind, 'claim_multiple');
});

test('search remains evidence-based: no citation annotations means no invented verification', async () => {
  let seen;
  const answer = await searchSecretaryWeb('سؤال عام اصطناعي', { apiKey: 'synthetic-only', fetcher: async (url, options) => {
    seen = JSON.parse(options.body);
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'بحثت وصححت الجواب https://invented.invalid', annotations: [] }] }] });
  } });
  assert.equal(seen.model, 'gpt-4.1-mini'); assert.equal(seen.max_output_tokens, 900);
  assert.deepEqual(seen.tools, [{type:'web_search', search_context_size:'medium'}]); assert.equal(seen.tool_choice, 'required');
  assert.equal(seen.input[1].content, 'سؤال عام اصطناعي');
  assert.doesNotMatch(JSON.stringify(seen), /previousQuestion|previousAnswer|تقرير داخلي|موظف اصطناعي/);
  assert.match(answer, /ما قدرت أتحقق/); assert.doesNotMatch(answer, /invented|صححت/);
});

