import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateSecretaryMemory, rememberSecretaryMistake, recallSecretaryMemory, personalMemoryCommand, updatePersonalMemory, personalMemory } from '../lib/secretary-memory.ts';
import { searchSecretaryWeb } from '../lib/secretary-intent.ts';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close()); migrateSecretaryMemory(db);
  const now=1788580000000;
  const write=(extra={})=>rememberSecretaryMistake(db,{conversation:'owner-private',role:'admin',question:'كيف أراجع اللوحات؟',answer:'جواب غير صحيح',scope:['t:one'],now,...extra});
  const read=(extra={})=>recallSecretaryMemory(db,{conversation:'owner-private',role:'admin',query:'مراجعة اللوحات',allowedScope:new Set(['t:one']),now,...extra});
  return {db,now,write,read};
}
test('mistakes remain disputed, deduplicate, normalize Arabic and expire',t=>{
  const f=fixture(t); f.write();f.write();
  assert.equal(f.read().length,1); assert.match(f.read()[0].guidance,/لا يثبت/);
  assert.equal(f.read({now:f.now+91*86400000}).length,0);
  assert.equal(f.read({query:'الفواتير'}).length,0);
});
test('memory never crosses conversation, role or revoked task access',t=>{
  const f=fixture(t);f.write();
  for(const extra of [{conversation:'group'},{role:'member'},{allowedScope:new Set()}]) assert.deepEqual(f.read(extra),[]);
});
test('bounded retrieval prioritizes relevance and keeps a finite archive',t=>{
  const f=fixture(t);
  for(let i=0;i<305;i++) f.write({question:`أعمال أخرى رقم ${i}`,now:f.now+i});
  f.write({now:f.now+306});
  assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_learning_memory').get().n,300);
  assert.match(f.read({now:f.now+307})[0].question,/اللوحات/);
});
test('personal memory explicitly replaces and forgets one topic, isolated by owner',t=>{
  const f=fixture(t);
  assert.equal(personalMemoryCommand('لو قلت احفظ عني: الأسلوب: مختصر'),null);
  updatePersonalMemory(f.db,'basem',personalMemoryCommand('احفظ عني: الأسلوب: مختصر'),f.now);
  updatePersonalMemory(f.db,'basem',personalMemoryCommand('احفظ عني: الأسلوب: مفصل'),f.now+1);
  assert.deepEqual(personalMemory(f.db,'basem').map(row=>({...row})),[{topic:'الأسلوب',body:'مفصل'}]);
  assert.deepEqual(personalMemory(f.db,'other'),[]);
  updatePersonalMemory(f.db,'basem',personalMemoryCommand('انس عني: الأسلوب'),f.now+2);
  assert.deepEqual(personalMemory(f.db,'basem'),[]);
});
test('grounded search needs a single OpenAI web_search call, never a second provider round-trip',async()=>{
  const requests=[];
  const fetcher=async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    return Response.json({output:[{type:'message',content:[{type:'output_text',text:'الأدلة كافية للتأكيد.',annotations:[
      {type:'url_citation',url:'https://example.org/source',title:'Official source'},
    ]}]}]});
  };
  const reply=await searchSecretaryWeb('public question',{apiKey:'synthetic',fetcher});
  assert.equal(requests.length,1);
  assert.match(reply,/الأدلة كافية/);assert.match(reply,/https:\/\/example.org\/source/);
});

test('live provider rejection returns honest unverified status without inventing an answer',async()=>{
 let calls=0;
 const answer=await searchSecretaryWeb('public question',{apiKey:'synthetic',fetcher:async()=>{calls++;return Response.json({error:{code:'request_too_large'}},{status:413});}});
 assert.equal(calls,1);assert.match(answer,/ما قدرت أتحقق/);assert.doesNotMatch(answer,/https:\/\//);
});

test('citation URLs are validated before rendering: private/loopback hosts and credentials are dropped, safe HTTPS ones remain',async()=>{
 const answer=await searchSecretaryWeb('public question',{apiKey:'synthetic',fetcher:async()=>Response.json({output:[{type:'message',content:[{type:'output_text',text:'نتائج متعددة',annotations:[
   {type:'url_citation',url:'https://example.org/page',title:'Actual source'},
   {type:'url_citation',url:'http://127.0.0.1/',title:'Loopback'},
   {type:'url_citation',url:'https://user:pass@example.org/','title':'Credentials'},
   {type:'url_citation',url:'https://192.168.1.1/','title':'Private'},
 ]}]}]})});
 assert.match(answer,/https:\/\/example.org\/page/);
 assert.doesNotMatch(answer,/127\.0\.0\.1|192\.168\.1\.1|user:pass/);
});

