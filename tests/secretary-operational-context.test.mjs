import test from 'node:test';
import assert from 'node:assert/strict';
import { secretaryOperationalContext } from '../lib/secretary-operational-context.ts';
import { inferSecretaryIntent } from '../lib/secretary-intent.ts';

test('uses known department and assigned task context without expanding scope or mutating records', () => {
  const actor = { id:'staff', name:'موظف تجريبي', role:'member', department:'الصيدليات', phone:'private' };
  const tasks = [{ id:'allowed', title:'فحص عد تجريبي', status:'progress', priority:'yellow', details:'قارن 12 صنفًا بالسجل', owner:actor.name, suggestedOwner:'مرشح تجريبي', dueDate:'2026-10-14', updatedAt:123, hiddenSecret:'private' }];
  const before = structuredClone({actor,tasks});
  const context = secretaryOperationalContext(actor,tasks);
  assert.equal(context.actor.department,'الصيدليات');
  assert.deepEqual(context.tasks.map(t=>t.id),['allowed']);
  assert.equal(context.tasks[0].ownerName,actor.name);
  assert.equal(context.tasks[0].suggestedOwnerName,'مرشح تجريبي');
  assert.equal(context.tasks[0].dueDate,'2026-10-14');
  assert.equal(context.tasks[0].details,'قارن 12 صنفًا بالسجل');
  assert.ok(!('phone' in context.actor));
  assert.ok(!('hiddenSecret' in context.tasks[0]));
  assert.deepEqual({actor,tasks},before);
});

test('missing data stay unknown, long details are bounded, empty authorized scope stays empty', () => {
  const actor = {id:'staff',name:'موظف تجريبي',role:'member'};
  assert.deepEqual(secretaryOperationalContext(actor,[]).tasks,[]);
  const {actor:a,tasks:[t]}=secretaryOperationalContext(actor,[{id:'allowed',title:'فحص',status:'open',priority:'green',details:'x'.repeat(20000)}]);
  assert.equal(a.department,null);
  assert.equal(t.ownerName,null);
  assert.equal(t.suggestedOwnerName,null);
  assert.equal(t.dueDate,null);
  assert.equal(t.updatedAt,null);
  assert.equal(t.details.length,400);
});

test('known staff context reaches provider with operational reasoning and existing tool boundaries', async () => {
  const input = {text:'عندي فرق بالعد، من وين أبدأ؟',...secretaryOperationalContext({id:'staff',name:'موظف تجريبي',role:'member',department:'الصيدليات'},[{id:'allowed',title:'فحص العد',status:'progress',priority:'yellow',details:'قارن 12 صنفًا بالسجل',owner:'موظف تجريبي',dueDate:'2026-10-14'}]),users:[],history:[],now:'2026-10-13T12:00:00Z'};
  let body;
  const plan=await inferSecretaryIntent(input,{apiKey:'synthetic-only',fetcher:async(_url,options)=>{
    body=JSON.parse(options.body);
    return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'chat',arguments:JSON.stringify({message:'ابدأ بإعادة عد الصنف المختلف وقارنه بالسجل؛ بعدها نراجع آخر حركة عليه.',taskId:'allowed'})}}]}}]});
  }});
  const sent=JSON.parse(body.messages[1].content);
  assert.equal(sent.actor.department,'الصيدليات');
  assert.equal(sent.tasks[0].details,input.tasks[0].details);
  assert.equal(sent.tasks[0].ownerName,'موظف تجريبي');
  assert.match(body.messages[0].content,/never ask the employee to repeat known information/);
  assert.match(body.messages[0].content,/staff reports and hypotheses/);
  assert.match(body.messages[0].content,/not proof of completion, disrespect or misconduct/);
  assert.match(body.messages[0].content,/suggested owner is not the assigned owner/);
  assert.equal(body.tool_choice,'required');
  assert.equal(body.parallel_tool_calls,false);
  assert.equal(plan.kind,'chat');
  assert.equal(plan.action,null);
});
