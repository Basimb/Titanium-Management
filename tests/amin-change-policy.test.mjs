import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {isReportableAudit,formatAminChangeNotice} from '../lib/amin-change-notice.ts';
import {createAminChangeMonitor} from '../lib/amin-change-monitor.ts';
const row=(action,entity_type='product',detail={})=>({action,entity_type,actor_name:'',details:JSON.stringify(detail)});
test('real mutations notify even when actor is missing or action is new',()=>{
 for(const a of ['product_update','edit','supplier_create','stock_adjustment'])assert.equal(isReportableAudit(row(a,'product',{previous:{qty:1},next:{qty:2}})),true);
 assert.match(formatAminChangeNotice([row('product_update')],[],Date.now()),/اسم المنفّذ غير متاح/);
});
test('checks and reads are silent even with a misleading summary or diff',()=>{
 for(const a of ['read_file','health_check','inspect','search','list','preview','status','secretary_command'])assert.equal(isReportableAudit(row(a)),false);
 assert.equal(isReportableAudit(row('read_file','product',{previous:{x:1},next:{x:2}})),false);
});
test('sales excluded while product price edits remain reportable',()=>{
 for(const entity of ['sale','sales','pos.order','pos.order.line','sale.order','sale.order.line'])assert.equal(isReportableAudit(row('create',entity)),false);
 assert.equal(isReportableAudit(row('sale_created')),false);
 assert.equal(isReportableAudit(row('edit','account.move',{move_type:'out_invoice'})),false);
 assert.equal(isReportableAudit(row('edit','product',{previous:{sale_price:1},next:{sale_price:2}})),true);
});
test('unchanged saves timestamp-only changes and synthetic work are silent',()=>{
 for(const d of [{previous:{a:1},next:{a:1}},{previous:{a:1,updatedAt:1},next:{a:1,updatedAt:2}},{changed:false},{synthetic:true},{test:true},{dryRun:true}])assert.equal(isReportableAudit(row('edit','product',d)),false);
});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'amin-change-policy-'));const file=path.join(root,'screen.php');await fs.writeFile(file,'before');
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE users(id TEXT,role TEXT,active INTEGER);INSERT INTO users VALUES('basem','admin',1);CREATE TABLE tasks(id TEXT);CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);CREATE TABLE agent_outbox(id TEXT,to_user TEXT,text TEXT,choices_json TEXT,state TEXT,created_at INTEGER,deliver_after INTEGER,source TEXT,reply_noticed_at INTEGER);`);
 const m=createAminChangeMonitor({db,enabled:()=>true,roots:[root],observeFiles:false,receiptDirectory:path.join(root,'receipts')});
 t.after(async()=>{m.stop();db.close();await fs.rm(root,{recursive:true,force:true});});return{root,file,db,m};
}
test('initial scan and identical save silent; first real edit notifies once',async t=>{
 const f=await fixture(t);assert.equal(f.m.tick().queued,false);f.m.noteFile(f.root,'screen.php');assert.equal(f.m.tick().queued,false);
 await fs.writeFile(f.file,'after');f.m.noteFile(f.root,'screen.php');assert.equal(f.m.tick().queued,true);
 assert.match(f.db.prepare('SELECT text FROM agent_outbox').get().text,/تغيّر محتوى ملف «screen.php»/);
 f.m.noteFile(f.root,'screen.php');assert.equal(f.m.tick().queued,false);
});
test('file creation and deletion are changes without invented attribution',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'new.php'),'x');f.m.noteFile(f.root,'new.php');assert.equal(f.m.tick().queued,true);
 await fs.unlink(f.file);f.m.noteFile(f.root,'screen.php');assert.equal(f.m.tick().queued,true);
 const texts=f.db.prepare('SELECT text FROM agent_outbox').all().map(x=>x.text).join('\n');assert.match(texts,/انضاف/);assert.match(texts,/انحذف/);assert.doesNotMatch(texts,/المسؤول: ChatGPT/);
});
test('production audit pipeline reports data edit and skips read and sale',async t=>{
 const f=await fixture(t);const put=f.db.prepare('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)');
 put.run(1,'','','read_file','product','1','{}',1);put.run(2,'','','create','pos.order','2','{}',2);assert.equal(f.m.tick().queued,false);
 put.run(3,'','','product_update','product','1',JSON.stringify({summary:'تغيّر سعر الصنف'}),3);assert.equal(f.m.tick().queued,true);assert.match(f.db.prepare('SELECT text FROM agent_outbox').get().text,/تغيّر سعر الصنف/);assert.equal(f.m.tick().queued,false);
});
