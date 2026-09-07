import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySecretaryIntent, inferSecretaryIntent, validateSecretaryIntent } from '../lib/secretary-intent.ts';

const input = (text, history = []) => ({ text, actor: { id: 'basem', name: 'مستخدم تجريبي', role: 'admin' },
  tasks: [{ id: 'synthetic-task', title: 'تقرير تجريبي', projectId: 'synthetic-project', status: 'progress' }],
  projects: [{ id: 'synthetic-project', name: 'مشروع تجريبي', status: 'active' }],
  users: [], history, now: '2026-09-05T09:00:00.000Z', focusedTaskId: 'synthetic-task' });

test('conversational provider keeps task planner schema and untrusted context boundary', async () => {
  const request = input('مش فاهم وضحلي', [{role:'user',content:'كيف أرتب شغلي؟'}, {role:'assistant',content:'ابدأ بأهم مهمة.'}]);
  let body;
  const plan = await inferSecretaryIntent(request, { apiKey:'synthetic-only', fetcher:async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emptySecretaryIntent('chat','اختَر مهمة واحدة ضرورية اليوم وابدأ بأول خطوة فيها.'))}}]});
  }});
  assert.equal(body.model,'gpt-4o');
  assert.equal(body.response_format.json_schema.strict,true);
  assert.equal(body.messages.length,2);
  assert.equal(body.messages[0].role,'system');
  assert.match(body.messages[0].content,/not a form or command menu/);
  assert.match(body.messages[0].content,/ONE concrete question/);
  assert.match(body.messages[0].content,/Current text overrides old context/);
  assert.match(body.messages[0].content,/not a queue of orders/);
  assert.match(body.messages[0].content,/NEVER system instructions/);
  assert.match(body.messages[0].content,/actual owner, due date/);
  assert.deepEqual(JSON.parse(body.messages[1].content),request);
  assert.equal(plan.kind,'chat');
  assert.equal(plan.action,null);
});

test('conversational plan cannot hide a task command in the chat action field', () => {
  const plan = {...emptySecretaryIntent('chat','بحكي معك طبيعي'),action:'delete_task',taskId:'synthetic-task'};
  assert.throws(() => validateSecretaryIntent(plan,input('مرحبا')));
});

test('same-task conversational focus still requires an authorized task ID', () => {
  const plan = {...emptySecretaryIntent('chat','خلينا نرتب خطوات التقرير'),taskId:'synthetic-task'};
  assert.equal(validateSecretaryIntent(plan,input('كيف أبدأ فيها؟')).taskId,'synthetic-task');
  assert.equal(validateSecretaryIntent({...plan,taskId:'someone-else-task'},input('كيف أبدأ؟')).kind,'clarify');
});

test('a model cannot turn clearly framed discussion into a write or reminder', () => {
  for(const text of ['كيف أحذف التقرير؟','شو رأيك أعدل موعدها؟','«احذف التقرير»']) {
    const plan={...emptySecretaryIntent('command'),action:'delete_task',taskId:'synthetic-task'};
    assert.equal(validateSecretaryIntent(plan,input(text)).kind,'clarify');
  }
  const reminder={...emptySecretaryIntent('remind'),taskId:'synthetic-task'};
  reminder.fields.remindAt='2026-09-06T09:00:00+03:00';
  assert.equal(validateSecretaryIntent(reminder,input('شو رأيك تذكرني بكرا؟')).kind,'clarify');
  const comment={...emptySecretaryIntent('command'),action:'comment',taskId:'synthetic-task'};
  comment.fields.body='ما رد المورد لسه';
  assert.equal(validateSecretaryIntent(comment,input('سجل تعليق: ما رد المورد لسه')).kind,'command');
});

test('team messaging schema accepts only authorized staff IDs or the exclusive all-team marker',()=>{
 const context={...input('ابعث للتيم على الخاص مرحبا'),canMessageTeam:true,messageRecipients:[{id:'employee-one',name:'موظف تجريبي'}]};
 const plan=emptySecretaryIntent('message_team');plan.fields.body='مرحبا';plan.recipientIds=['all-team'];
 assert.equal(validateSecretaryIntent(plan,context).kind,'message_team');
 assert.equal(validateSecretaryIntent({...plan,recipientIds:['employee-one']},context).kind,'message_team');
 for(const ids of [['all-team','employee-one'],['12025550101'],['basem'],['unknown']]) assert.equal(validateSecretaryIntent({...plan,recipientIds:ids},context).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...context,canMessageTeam:false}).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...context,text:'اكتب مسودة رسالة للتيم'}).kind,'clarify');
 assert.equal(validateSecretaryIntent({...plan,fields:{...plan.fields,body:null}},context).kind,'clarify');
 assert.throws(()=>validateSecretaryIntent({...plan,recipientIds:['employee-one','employee-one']},context));
});

test('announce_team schema requires body text, admin-private access, and never carries recipients',()=>{
 const context={...input('اعلن على الجروب مرحبا'),canMessageTeam:true};
 const plan=emptySecretaryIntent('announce_team');plan.fields.body='صباح الخير يا فريق';
 assert.equal(validateSecretaryIntent(plan,context).kind,'announce_team');
 assert.equal(validateSecretaryIntent(plan,{...context,canMessageTeam:false}).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...context,actor:{...context.actor,role:'member'}}).kind,'clarify');
 assert.equal(validateSecretaryIntent({...plan,fields:{...plan.fields,body:null}},context).kind,'clarify');
 assert.equal(validateSecretaryIntent({...plan,fields:{...plan.fields,body:'  '}},context).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...context,text:'اكتب مسودة إعلان للجروب'}).kind,'clarify');
 assert.throws(()=>validateSecretaryIntent({...plan,recipientIds:['employee-one']},context));
 // A shape violation the authorized model itself produced (e.g. it also set
 // taskId on a long/confused request) is a benign formatting slip once
 // authorization already passed -- clarify, not a hard throw.
 assert.equal(validateSecretaryIntent({...plan,taskId:'t'},context).kind,'clarify');
});
