import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySecretaryIntent, inferSecretaryIntent, validateSecretaryIntent, searchSecretaryWeb }
  from '../lib/secretary-intent.ts';

const context = (extra = {}) => ({
  text: 'جوابك غلط، راجع السؤال', actor: { id: 'basem', name: 'باسم تجريبي', role: 'admin' },
  tasks: [{ id: 'task-test', title: 'تجهيز تقرير داخلي', projectId: 'project-test', status: 'progress', priority: 'red' }],
  projects: [{ id: 'project-test', name: 'مشروع داخلي تجريبي', status: 'active' }],
  users: [{ id: 'member-test', name: 'موظف اصطناعي' }],
  history: [], now: '2026-09-06T08:00:00.000Z', focusedTaskId: 'task-test',
  canMessageTeam: true, messageRecipients: [{ id: 'member-test', name: 'موظف اصطناعي' }],
  review: { previousQuestion: 'شو يعني اللون الأخضر؟', previousAnswer: 'يعني أن المهمة انتهت.' }, ...extra,
});
const response = plan => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] });

test('review retains the same bounded Groq call and receives quoted context plus explicit truthful identity policy', async () => {
  const input = context(), seen = [];
  const plan = await inferSecretaryIntent(input, { apiKey: 'synthetic-only', fetcher: async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return response(emptySecretaryIntent('chat', 'التصحيح: الأخضر أولوية عادية، وليس دليلًا على إنجاز المهمة.'));
  } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  const body = seen[0].body, prompt = body.messages[0].content;
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.reasoning_effort, 'low'); assert.equal(body.max_completion_tokens, 1300);
  assert.equal(body.response_format.json_schema.strict, true);
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
    text: 'جوابك غلط، موافق نفذها', taskDraft: { projectId: 'project-test', title: 'قديمة', details: null, priority: null, ownerId: null, dueDate: null } });
  const plans = [
    { ...emptySecretaryIntent('command'), action: 'delete_task', taskId: 'task-test' },
    { ...emptySecretaryIntent('command'), action: 'comment', taskId: 'task-test', fields: { ...emptySecretaryIntent().fields, body: 'تحديث مخترع' } },
    { ...emptySecretaryIntent('task_draft'), intakeMode: 'continue', projectId: 'project-test' },
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

test('review keeps factual read paths and still validates authorized task/project and owner-only message status', () => {
  for (const kind of ['chat', 'clarify', 'help', 'summary', 'report', 'projects', 'message_status']) {
    assert.equal(validateSecretaryIntent(emptySecretaryIntent(kind, ['chat', 'clarify'].includes(kind) ? 'نقطة المراجعة' : null), context()).kind, kind);
  }
  const details = { ...emptySecretaryIntent('details'), taskId: 'task-test', projectId: 'project-test' };
  assert.equal(validateSecretaryIntent(details, context()).kind, 'details');
  assert.equal(validateSecretaryIntent({ ...details, taskId: 'foreign-task' }, context()).kind, 'clarify');
  assert.equal(validateSecretaryIntent({ ...details, projectId: 'foreign-project' }, context()).kind, 'clarify');
  assert.equal(validateSecretaryIntent(emptySecretaryIntent('message_status'), context({ actor: { id: 'member-test', name: 'موظف اصطناعي', role: 'member' } })).kind, 'clarify');
});

test('review search permits a standalone public query but refuses catalog names and private identifiers', () => {
  assert.equal(validateSecretaryIntent(emptySecretaryIntent('search', 'ما الفرق بين الطقس والمناخ؟'), context()).kind, 'search');
  for (const query of ['ابحث عن تجهيز تقرير داخلي', 'أخبار مشروع داخلي تجريبي', 'عنوان موظف اصطناعي', 'باسم تجريبي',
    'رمز الدخول ١٢٣٤٥٦', 'السعر للحساب ۱۲۳۴۵۶', 'حساب 123456', 'test@example.invalid', 'قائمة مشاريعي']) {
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

test('search remains evidence-based: no tool results means no invented verification or citations', async () => {
  let seen;
  const answer = await searchSecretaryWeb('سؤال عام اصطناعي', { apiKey: 'synthetic-only', fetcher: async (url, options) => {
    seen = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: 'بحثت وصححت الجواب https://invented.invalid', executed_tools: [] } }] });
  } });
  assert.equal(seen.model, 'openai/gpt-oss-120b'); assert.equal(seen.max_completion_tokens, 2048);
  assert.deepEqual(seen.tools, [{type:'browser_search'}]); assert.equal(seen.tool_choice, 'required');
  assert.equal(seen.messages[1].content, 'سؤال عام اصطناعي');
  assert.doesNotMatch(JSON.stringify(seen), /previousQuestion|previousAnswer|تقرير داخلي|موظف اصطناعي/);
  assert.match(answer, /ما قدرت أتحقق/); assert.doesNotMatch(answer, /invented|صححت/);
});

