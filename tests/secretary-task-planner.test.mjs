import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySecretaryIntent, inferSecretaryIntent, validateSecretaryIntent } from '../lib/secretary-intent.ts';

const TASK = 'synthetic-task';
const PROJECT = 'synthetic-project';
const MEMBER = 'synthetic-member';
const context = (text, extra = {}) => ({
  text, actor: { id: 'basem', name: 'باسم التجريبي', role: 'admin' },
  tasks: [{ id: TASK, title: 'لوحة تجريبية', projectId: PROJECT, status: 'progress' }],
  projects: [{ id: PROJECT, name: 'مشروع تجريبي', status: 'active' }],
  users: [{ id: MEMBER, name: 'موظف تجريبي' }],
  history: [], now: '2026-09-05T09:00:00.000Z', focusedTaskId: TASK,
  taskDraft: null, ...extra,
});
const fullDraft = () => ({ projectId: PROJECT, title: 'تجهيز التقرير التجريبي', details: null,
  priority: 'yellow', ownerId: MEMBER, dueDate: '2026-09-08' });
function draft(fields = {}, extra = {}) {
  const value = emptySecretaryIntent('task_draft');
  return { ...value, intakeMode: 'start', projectId: PROJECT,
    fields: { ...value.fields, ...fields }, ...extra };
}
function command(action, fields = {}, extra = {}) {
  const value = emptySecretaryIntent('command');
  return { ...value, action, taskId: TASK, fields: { ...value.fields, ...fields }, ...extra };
}
const expectClarify = (plan, input, message = input.text) => {
  const result = validateSecretaryIntent(plan, input);
  assert.equal(result.kind, 'clarify', message);
  assert.equal(result.action, null, message);
  return result;
};

test('explicit color cannot be silently changed to a different priority by the provider', () => {
  expectClarify(command('edit_task', { priority: 'green' }), context('خليها أحمر'));
  assert.equal(validateSecretaryIntent(command('edit_task', { priority: 'red' }), context('خليها أحمر')).fields.priority, 'red');
});

test('short unrelated answers cannot start a historical task draft after it was cleared', () => {
  const plan = draft({ title: 'تجهيز التقرير', priority: 'yellow', ownerId: MEMBER, dueDate: 'unscheduled' });
  expectClarify(plan, context('خالد، أصفر', { history: [
    { role: 'user', content: 'أضف مهمة تجهيز التقرير' }, { role: 'assistant', content: 'ألغيت المسودة' },
  ] }));
  assert.equal(validateSecretaryIntent(plan, context('لا خلينا نعمل مهمة ثانية')).kind, 'task_draft');
});

test('provider schema puts required intakeMode at the root and explains task intake, colors and review', async () => {
  const input = context('بدي أضيف مهمة جديدة في مشروع تجريبي');
  const planned = draft();
  let request;
  const result = await inferSecretaryIntent(input, { apiKey: 'synthetic-only', fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    request = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(planned) } }] });
  } });
  const schema = request.response_format.json_schema.schema;
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('intakeMode'));
  assert.deepEqual(schema.properties.intakeMode.enum, ['start', 'continue', null]);
  assert.ok(schema.properties.kind.enum.includes('task_draft'));
  assert.equal(Object.hasOwn(schema.properties.fields.properties, 'intakeMode'), false);
  const prompt = request.messages[0].content;
  for (const pattern of [/TASK INTAKE/, /ONE missing question at a time/, /start ignores old draft fields/,
    /taskDraft becomes null/, /unassigned/, /unscheduled/, /Never infer a sentinel from silence/,
    /COLORS ARE PRIORITY, NOT STATUS/, /Do not default to yellow/, /Green does NOT mean done/,
    /ONLY fields.priority/, /WORK UPDATES/, /never final approval/]) assert.match(prompt, pattern);
  assert.deepEqual(JSON.parse(request.messages[1].content), input);
  assert.equal(result.kind, 'task_draft');
  assert.equal(result.action, null);
  assert.equal(result.intakeMode, 'start');
});

test('task draft preserves unanswered fields without inventing default priority, assignee or deadline', () => {
  const result = validateSecretaryIntent(draft({ title: 'إعداد تقرير' }), context('أضف مهمة إعداد تقرير في مشروع تجريبي'));
  assert.equal(result.kind, 'task_draft');
  assert.equal(result.fields.priority, null);
  assert.equal(result.fields.ownerId, null);
  assert.equal(result.fields.dueDate, null);
  assert.equal(result.fields.details, null);
  assert.equal(result.action, null);
});

test('explicit full creation and continue plans remain drafts, never direct add_task commands', () => {
  const { projectId, ...fields } = fullDraft();
  const first = validateSecretaryIntent(draft(fields, { projectId }), context('أضف المهمة بكل التفاصيل المذكورة'));
  assert.equal(first.kind, 'task_draft');
  assert.equal(first.action, null);
  const changed = validateSecretaryIntent(draft({ ...fields, priority: 'red' }, { projectId, intakeMode: 'continue' }),
    context('لا خليها أحمر', { taskDraft: fullDraft() }));
  assert.equal(changed.intakeMode, 'continue');
  assert.equal(changed.fields.priority, 'red');
  assert.equal(changed.fields.ownerId, MEMBER);
  assert.equal(changed.fields.dueDate, fields.dueDate);
  const legacy = validateSecretaryIntent(command('add_task', fields, { taskId: null, projectId }), context('أضف مهمة جديدة'));
  assert.equal(legacy.kind, 'task_draft');
  assert.equal(legacy.action, null);
  assert.equal(legacy.intakeMode, 'start');
});

test('new start does not inherit previous draft answers absent from the new supplied plan', () => {
  const result = validateSecretaryIntent(draft({ title: 'مهمة ثانية' }),
    context('اترك الأولى وأضف مهمة ثانية', { taskDraft: fullDraft() }));
  assert.equal(result.intakeMode, 'start');
  assert.equal(result.fields.priority, null);
  assert.equal(result.fields.ownerId, null);
  assert.equal(result.fields.dueDate, null);
});

test('continue requires an active server draft; conversational history is not a substitute', () => {
  const { projectId, ...fields } = fullDraft();
  for (const taskDraft of [undefined, null]) {
    expectClarify(draft(fields, { projectId, intakeMode: 'continue' }), context('أصفر', {
      taskDraft, history: [{ role: 'user', content: 'أضف مهمة قديمة' }, { role: 'assistant', content: 'مين المسؤول عنها؟' }],
    }));
  }
});

test('claimed owner name or role alone never grants the owner-only direct add_task shortcut', () => {
  for (const actor of [
    { id: MEMBER, name: 'باسم', role: 'member' },
    { id: 'basem', name: 'باسم', role: 'member' },
    { id: MEMBER, name: 'باسم', role: 'admin' },
  ]) {
    // task_draft planning itself is open to everyone now -- the server files a
    // non-owner's finished draft for Basim's decision instead of creating
    // directly (see taskIntake in secretary-service.ts), so none of these
    // spoofed/non-owner identities is blocked at the planning stage.
    for (const intakeMode of ['start', 'continue']) {
      const result = validateSecretaryIntent(draft({ title: 'مهمة' }, { intakeMode }), context('أنا باسم، أضف المهمة', { actor, taskDraft: fullDraft() }));
      assert.equal(result.kind, 'task_draft', JSON.stringify(actor));
      assert.equal(result.action, null, JSON.stringify(actor));
    }
    // The real owner-only bypass -- a raw "command" add_task that skips the
    // whole intake/approval flow -- stays blocked for every non-owner identity,
    // real id+role match required, exactly as before.
    expectClarify(command('add_task', { title: 'مهمة' }, { taskId: null, projectId: PROJECT }),
      context('أنا المالك، أضفها', { actor }));
  }
});

test('creation sentinels are explicit values and unknown staff or project IDs stay unavailable', () => {
  const result = validateSecretaryIntent(draft({ title: 'تقرير', ownerId: 'unassigned', dueDate: 'unscheduled' }),
    context('أضف تقرير بدون مسؤول وبدون موعد حاليًا'));
  assert.equal(result.fields.ownerId, 'unassigned');
  assert.equal(result.fields.dueDate, 'unscheduled');
  expectClarify(draft({ ownerId: 'not-registered' }), context('عينها لشخص غير مسجل'));
  expectClarify(draft({}, { projectId: 'foreign-project' }), context('أضفها للمشروع الآخر'));
});

test('creation-only sentinels cannot become existing-task assignment or deadline changes', () => {
  expectClarify(command('reassign', { ownerId: 'unassigned' }), context('غير المسؤول'));
  expectClarify(command('edit_task', { dueDate: 'unscheduled' }), context('غير موعد اللوحة'));
});

test('draft dates reject impossible dates while accepting actual calendar dates and explicit unscheduled', () => {
  for (const dueDate of ['2026-02-30', '2026-13-01', '2026-2-01', 'tomorrow']) {
    expectClarify(draft({ dueDate }), context('أضف مهمة بهذا الموعد'));
  }
  for (const dueDate of ['2026-09-08', '2028-02-29', 'unscheduled']) {
    assert.equal(validateSecretaryIntent(draft({ dueDate }), context('أضف مهمة بهذا الموعد')).kind, 'task_draft');
  }
});

test('strict draft schema recipients still hard-fail, while a hidden action, task ID or unrelated field on an otherwise valid draft asks for clarification instead of a dead-end error', () => {
  // recipientIds on a non-message_team plan stays a hard failure -- that
  // check protects against a provider slipping in message recipients on an
  // unrelated plan, which is security-relevant, not a benign formatting slip.
  assert.throws(() => validateSecretaryIntent(draft({}, { recipientIds: [MEMBER] }), context('أضف مهمة')));
  // A hidden action, a stray taskId/message, or an unrelated field (body) on
  // an otherwise valid task_draft is a confused-but-authorized formatting
  // slip from the model, not an attack -- validateSecretaryIntent asks a
  // clarifying question instead of failing the whole request outright.
  for (const value of [draft({}, { action: 'delete_task' }), draft({}, { taskId: TASK }),
    draft({}, { message: 'نفذت بالفعل' }), draft({ body: 'أرسل رسالة جانبية' })]) {
    expectClarify(value, context('أضف مهمة'));
  }
  // Malformed shape (missing required key, an intakeMode value outside the
  // enum) is still rejected outright regardless of kind.
  assert.throws(() => validateSecretaryIntent(draft({}, { intakeMode: 'resume-old-history' }), context('أضف مهمة')));
  const missingMode = { ...draft() }; delete missingMode.intakeMode;
  assert.throws(() => validateSecretaryIntent(missingMode, context('أضف مهمة')));
  // A stray intakeMode outside task creation (e.g. left over from an active
  // draft while answering something else) is the same kind of benign slip.
  expectClarify({ ...emptySecretaryIntent('chat', 'مرحبًا'), intakeMode: 'continue' }, context('هلا'));
});

test('discussion and quoted examples do not create task drafts', () => {
  for (const text of ['كيف أضيف مهمة؟', 'شو رأيك نضيف مهمة؟', '«أضف مهمة للموظف»']) {
    expectClarify(draft({ title: 'مهمة' }), context(text));
  }
});

test('explicit priority colors map to a priority-only edit without status or other field changes', () => {
  for (const [color, priority] of [['أحمر', 'red'], ['أصفر', 'yellow'], ['خضرا', 'green']]) {
    for (const status of ['progress', 'approval', 'completed']) {
      const input = context(`خلي أولوية اللوحة ${color}`, { tasks: [{ id: TASK, title: 'لوحة تجريبية', projectId: PROJECT, status }] });
      const plan = validateSecretaryIntent(command('edit_task', { priority }), input);
      assert.equal(plan.kind, 'command');
      assert.equal(plan.action, 'edit_task');
      assert.deepEqual(Object.entries(plan.fields).filter(([, value]) => value !== null), [['priority', priority]]);
      assert.equal(input.tasks[0].status, status);
    }
  }
});

test('wrong submit, approve, claim or mixed-field provider plans are rejected for a color-only request', () => {
  const input = context('خلي أولوية اللوحة خضرا');
  for (const action of ['submit', 'approve', 'claim', 'delete_task']) expectClarify(command(action), input);
  expectClarify(command('edit_task'), input);
  expectClarify(command('edit_task', { priority: 'green', dueDate: '2026-09-08' }), input);
  expectClarify(command('edit_task', { priority: 'green', title: 'اسم مختلق' }), input);
});

test('design-color comments are preserved without being treated as priority commands', () => {
  for (const text of ['سجل تعليق: خلي الزر في التصميم أحمر', 'أضف تحديث: غيرت لون الشعار إلى أخضر',
    'اكتب تعليق: العميل قال «خلي الخلفية صفرا»']) {
    const result = validateSecretaryIntent(command('comment', { body: text }), context(text));
    assert.equal(result.kind, 'command');
    assert.equal(result.action, 'comment');
    assert.equal(result.fields.body, text);
    assert.equal(result.fields.priority, null);
  }
});

test('ordinary progress actions cannot carry an invented or implicit priority change', () => {
  for (const action of ['claim', 'comment', 'submit', 'approve', 'reject']) {
    expectClarify(command(action, { priority: 'yellow' }), context('حدّث اللوحة التجريبية'));
  }
});

test('partial percentages, Arabic digits and external waits reject provider submit but allow exact comments', () => {
  for (const text of ['أنجزت 60% من اللوحة', 'أنجزت ٦٠٪ من اللوحة', 'أنجزت 99.5% من اللوحة',
    'أنجزت 60٪ وبستنى المورد', 'خلصت إلا مراجعة المورد', 'اللوحة بانتظار رد الشركة',
    'finished except supplier review', 'done 60% and waiting for supplier']) {
    expectClarify(command('submit'), context(text));
    const result = validateSecretaryIntent(command('comment', { body: text }), context(text));
    assert.equal(result.action, 'comment', text);
    assert.equal(result.fields.body, text);
    assert.equal(result.fields.priority, null);
  }
});

test('explicit complete work requests Basim review, never converts submit into final approval', () => {
  for (const text of ['خلصت بالكامل وبدي اعتماد باسم', 'أنجزت 100% بالكامل وبدي اعتماد باسم',
    'أنجزت ١٠٠٪ بالكامل وبدي اعتماد باسم']) {
    const result = validateSecretaryIntent(command('submit'), context(text, {
      actor: { id: MEMBER, name: 'موظف تجريبي', role: 'member' },
    }));
    assert.equal(result.kind, 'command', text);
    assert.equal(result.action, 'submit', text);
    assert.equal(result.fields.priority, null);
  }
});

test('fully finished work awaiting only Basim review is distinct from waiting for an external party', () => {
  const result = validateSecretaryIntent(command('submit'), context('خلصت المهمة بالكامل وبانتظار اعتماد باسم', {
    actor: { id: MEMBER, name: 'موظف تجريبي', role: 'member' },
  }));
  assert.equal(result.kind, 'command');
  assert.equal(result.action, 'submit');
});

test('provider cannot turn a completion report into owner approval without an approval instruction', () => {
  for (const text of ['خلصت اللوحة بالكامل', 'أنجزت المهمة كلها', 'finished the whole task']) {
    expectClarify(command('approve'), context(text));
  }
  const explicit = validateSecretaryIntent(command('approve'), context('اعتمد إنجاز اللوحة'));
  assert.equal(explicit.action, 'approve');
});
