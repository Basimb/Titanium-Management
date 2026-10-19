import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {migrateAminServerWork,queueAminServerWork,aminServerVote,createAminServerWorker,planAminServerStep} from '../lib/amin-server-work.ts';
import {emptySecretaryIntent,validateSecretaryIntent} from '../lib/secretary-intent.ts';
const at=1792044000000,actor={id:'basem',role:'admin',active:1};
const md5=s=>createHash('md5').update(s).digest('hex');
const ok=text=>({ok:true,result:{content:[{type:'text',text}]}});
function fixture(t,steps){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('basem','مدير تجريبي','admin',1);CREATE TABLE tasks(id TEXT PRIMARY KEY);CREATE TABLE agent_outbox(id TEXT PRIMARY KEY,to_user TEXT,text TEXT,choices_json TEXT,state TEXT,created_at INTEGER,deliver_after INTEGER,source TEXT,reply_noticed_at INTEGER);`);migrateAminServerWork(db);
 let now=at,unknown=false;const files=new Map([['qa_data/synthetic.txt','before']]),calls=[];
 const rpc=async(method,p)=>{
  if(method==='tools/list')return {ok:true,result:{tools:[{name:'read_file'},{name:'write_file'},{name:'file_hash'}]}};
  calls.push(p);
  if(p.name==='read_file')return ok(files.get(p.arguments.path)||'');
  if(p.name==='file_hash')return ok('size=1 md5='+md5(files.get(p.arguments.path)||''));
  if(p.name==='write_file'){
   if(md5(files.get(p.arguments.path)||'')!==p.arguments.expect_md5)return {ok:true,result:{isError:true,content:[{type:'text',text:'version conflict; no write'}]}};
   files.set(p.arguments.path,p.arguments.content);if(unknown)throw Error('timeout-after-write');return ok('size_after=5 md5_after='+md5(p.arguments.content));
  }
  throw Error('unexpected host action');
 };
 let plans=0;const plan=async()=>{const step=steps[plans++];if(!step)throw Error('unexpected model call');return step;};
 const create=()=>createAminServerWorker({db,enabled:()=>true,plan,rpc,now:()=>now});const worker=create();t.after(()=>worker.stop());
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const enqueue=(eventKey='one')=>tx(()=>queueAminServerWork(db,actor,{eventKey,conversation:'private',request:'عدّل الملف الاصطناعي فقط',now}));
 const vote=(yes=true,options={})=>{const row=db.prepare('SELECT * FROM amin_server_actions WHERE state=\'proposed\'').get();return tx(()=>aminServerVote(db,actor,{conversation:'private',choice:{questionId:row.poll_id,optionId:yes?row.yes_id:row.no_id},now,...options}));};
 return {db,worker,create,files,calls,tx,enqueue,vote,setUnknown(){unknown=true;},advance(n){now+=n;},get plans(){return plans;}};
}
const read={name:'read_file',args:{path:'qa_data/synthetic.txt'},summary:'أفحص النسخة الحالية'};
const write={name:'write_file',args:{path:'qa_data/synthetic.txt',content:'after',expect_md5:md5('before')},summary:'أغيّر النص الاصطناعي من before إلى after دون تعديل أي ملف آخر'};
test('durable owner job investigates, waits for an exact poll, executes once and verifies returned content hash',async t=>{
 const f=fixture(t,[read,write,{finish:'الملف الاصطناعي أصبح after.'}]);f.enqueue();f.enqueue();assert.equal(f.db.prepare('SELECT count(*) n FROM amin_server_jobs').get().n,1);
 await f.worker.tick();await f.worker.tick();assert.equal(f.files.get('qa_data/synthetic.txt'),'before');assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'waiting_approval');
 const poll=JSON.parse(f.db.prepare("SELECT choices_json FROM agent_outbox WHERE choices_json IS NOT NULL").get().choices_json);assert.match(poll.id,/^ASQ/);assert.equal(f.vote().status,'queued');
 await f.worker.tick();assert.equal(f.files.get('qa_data/synthetic.txt'),'after');assert.equal(f.db.prepare("SELECT result_json FROM amin_server_actions WHERE name='write_file'").get().result_json.includes('"verified":true'),true);
 await f.worker.tick();await f.worker.tick();assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'completed');assert.equal(f.calls.filter(x=>x.name==='write_file').length,1);
});
test('wrong actor, wrong private conversation and duplicate poll cannot approve a proposed write',async t=>{
 const f=fixture(t,[write]);f.enqueue();await f.worker.tick();const row=f.db.prepare('SELECT * FROM amin_server_actions').get();
 assert.throws(()=>f.tx(()=>queueAminServerWork(f.db,{...actor,id:'staff'},{eventKey:'bad',conversation:'private',request:'x',now:at})));
 assert.equal(f.tx(()=>aminServerVote(f.db,{...actor,id:'staff'},{conversation:'private',choice:{questionId:row.poll_id,optionId:row.yes_id},now:at})).status,'denied');
 assert.equal(f.vote(true,{conversation:'other'}).status,'stale');assert.equal(f.vote(false).status,'cancelled');
 assert.equal(f.tx(()=>aminServerVote(f.db,actor,{conversation:'private',choice:{questionId:row.poll_id,optionId:row.yes_id},now:at})).status,'stale');await f.worker.tick();assert.equal(f.calls.length,0);
});
test('expired approval never writes and the universal cancel option rejects the proposal',async t=>{
 const f=fixture(t,[write]);f.enqueue();await f.worker.tick();f.advance(31*60000);await f.worker.tick();assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'expired');assert.equal(f.calls.length,0);
 const g=fixture(t,[write]);g.enqueue();await g.worker.tick();const a=g.db.prepare('SELECT * FROM amin_server_actions').get();assert.equal(g.tx(()=>aminServerVote(g.db,actor,{conversation:'private',choice:{questionId:a.poll_id,optionId:'NOPEX'},now:at})).status,'cancelled');
});
test('a file changed after the preview is not overwritten and cannot be reported as completed',async t=>{
 const f=fixture(t,[write,{finish:'تم التعديل بنجاح'}]);f.enqueue();await f.worker.tick();f.files.set('qa_data/synthetic.txt','someone-else');f.vote();await f.worker.tick();await f.worker.tick();
 assert.equal(f.files.get('qa_data/synthetic.txt'),'someone-else');assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'blocked');
 assert.ok(!f.db.prepare('SELECT text FROM agent_outbox ORDER BY rowid DESC LIMIT 1').get().text.includes('تم التعديل بنجاح'));
});
test('timeout after an external write is unknown and is never automatically replayed',async t=>{
 const f=fixture(t,[write]);f.enqueue();await f.worker.tick();f.vote();f.setUnknown();await f.worker.tick();await f.worker.tick();
 assert.equal(f.files.get('qa_data/synthetic.txt'),'after');assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'uncertain');assert.equal(f.calls.filter(x=>x.name==='write_file').length,1);
 const next=f.create();await next.tick();next.stop();assert.equal(f.calls.filter(x=>x.name==='write_file').length,1);
});
test('process recovery suspends an in-flight action without replay',async t=>{
 const f=fixture(t,[write]);f.enqueue();await f.worker.tick();f.vote();f.db.prepare("UPDATE amin_server_actions SET state='executing'").run();f.db.prepare("UPDATE amin_server_jobs SET status='running'").run();
 const next=f.create();await next.tick();next.stop();assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'uncertain');assert.equal(f.calls.length,0);
});
test('worker rejects shell, credential access and unversioned writes before tool invocation',async t=>{
 for(const step of [{name:'exec',args:{cmd:'whoami'},summary:'x'},{name:'read_file',args:{path:'qa_data/.credentials.json'},summary:'x'},{name:'write_file',args:{path:'qa_data/a.txt',content:'x'},summary:'x'}]){
  const f=fixture(t,[step]);f.enqueue();await f.worker.tick();assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'failed');assert.equal(f.calls.length,0);
 }
});
test('owner deactivation before a vote is executed prevents all host operations',async t=>{
 const f=fixture(t,[write]);f.enqueue();await f.worker.tick();f.vote();f.db.prepare("UPDATE users SET active=0 WHERE id='basem'").run();await f.worker.tick();assert.equal(f.calls.length,0);
});
test('planner never accepts an invented server job for staff, unavailable runtime, review or hypothetical request',()=>{
 const input={text:'عدّل الملف على السيرفر',actor:{id:'basem',role:'admin',name:'تجريبي'},tasks:[],users:[],history:[],now:new Date(at).toISOString(),canRunServerWork:true};const p={...emptySecretaryIntent('server_work'),fields:{...emptySecretaryIntent().fields,body:'fabricated body'}};
 assert.equal(validateSecretaryIntent(p,input).fields.body,input.text);
 for(const i of [{...input,actor:{...input.actor,id:'staff'}},{...input,canRunServerWork:false},{...input,review:{previousQuestion:'x',previousAnswer:'y'}},{...input,text:'لو بدنا نعدل الملف على السيرفر شو بصير؟'}])assert.notEqual(validateSecretaryIntent(p,i).kind,'server_work');
});
test('server agent API uses the configured model and accepts one structured tool step only',async()=>{
 let model;const plan=await planAminServerStep([{role:'user',content:'synthetic'}],[],{apiKey:'synthetic',model:'existing-model'},async(_url,opts)=>{model=JSON.parse(opts.body).model;return Response.json({choices:[{message:{tool_calls:[{function:{name:'host_action',arguments:JSON.stringify({name:'read_file',arguments_json:'{"path":"qa_data/a.txt"}',summary:'أفحص الملف'})}}]}}]});});
 assert.equal(model,'existing-model');assert.equal(plan.name,'read_file');
});
test('a fluent completion claim with no successful tool is not accepted as execution',async t=>{
 const f=fixture(t,[{finish:'تم تعديل السيرفر بنجاح'}]);f.enqueue();await f.worker.tick();assert.equal(f.db.prepare('SELECT status FROM amin_server_jobs').get().status,'blocked');assert.ok(!f.db.prepare('SELECT text FROM agent_outbox').get().text.includes('تم تعديل السيرفر بنجاح'));
});
