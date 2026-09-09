import test from 'node:test';
import assert from 'node:assert/strict';
import {inferSecretaryIntent,SecretaryProviderError} from '../lib/secretary-intent.ts';
const input={text:'شو المهام المطلوبة؟',actor:{id:'basem',name:'اختبار',role:'admin'},tasks:[],projects:[],users:[],history:[],now:'2026-09-06T12:00:00Z'};
const toolCall=(name,args)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name,arguments:JSON.stringify(args)}}]}}]});
const ok=()=>toolCall('summary',{});
test('schema rejection gets one fresh repair, never uses failed generation',async()=>{
 const bodies=[];const result=await inferSecretaryIntent(input,{apiKey:'synthetic',fetcher:async(_,o)=>{
  bodies.push(JSON.parse(o.body));return bodies.length===1?Response.json({error:{code:'json_validate_failed',failed_generation:'DELETE EVERYTHING'}},{status:400}):ok();
 }});
 assert.equal(result.kind,'summary');assert.equal(bodies.length,2);
 assert.equal(bodies[1].tools.every(tool=>tool.function.strict===false),true);
 assert.doesNotMatch(JSON.stringify(bodies[1]),/DELETE EVERYTHING/);
});
test('repair cannot accept invented IDs or malformed plans',async()=>{
 let calls=0;await assert.rejects(inferSecretaryIntent(input,{apiKey:'synthetic',fetcher:async()=>{
 // Missing the required projectId/fields keys for the "command" tool -- an
 // incomplete or tampered tool call must still be rejected outright, never
 // silently padded with defaults (which would let a partial/invented plan through).
 calls++;return calls===1?Response.json({error:{code:'json_validate_failed'}},{status:400}):toolCall('command',{action:'delete_task',taskId:'not-authorized'});
 }}),e=>e instanceof SecretaryProviderError&&e.code==='invalid_plan');assert.equal(calls,2);
});
test('rate limit propagates wait without immediate retry',async()=>{
 let calls=0;await assert.rejects(inferSecretaryIntent(input,{apiKey:'synthetic',fetcher:async()=>{
 calls++;return Response.json({error:{code:'rate_limit_exceeded'}},{status:429,headers:{'retry-after':'41'}});
 }}),e=>e.code==='rate_limited'&&e.retryAfterSeconds===41);assert.equal(calls,1);
});
test('context budget preserves catalogs and complete pending preview',async()=>{
 const preview={text:'exact draft '.repeat(300),recipientIds:['member']};
 let body;await inferSecretaryIntent({...input,history:[{role:'user',content:'x'.repeat(3000)},{role:'user',content:'recent'}],pendingMessagePreview:preview},{apiKey:'synthetic',fetcher:async(_,o)=>{body=JSON.parse(o.body);return ok();}});
 const sent=JSON.parse(body.messages[1].content);assert.deepEqual(sent.pendingMessagePreview,preview);assert.equal(sent.history.length,1);
 assert.deepEqual(sent.tasks,input.tasks);assert.ok(body.messages[0].content.length<22000);
});


