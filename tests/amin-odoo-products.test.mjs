import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createProductMonitor,createProductReader,productFields} from '../lib/amin-odoo-product-monitor.ts';
const schema={name:{type:'char'},list_price:{type:'float'},barcode:{type:'char'},discount_limit:{type:'float',store:true,readonly:false,string:'Discount limit'},qty_available:{type:'float'},computed_discount:{type:'float',store:false,readonly:true}};
function fixture(opts={}){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE queue(id INTEGER PRIMARY KEY,text TEXT)');let time=Date.parse('2026-10-15T17:00:00Z'),fail=false;
 const products={'product.template':[{id:1,name:'حليب',barcode:'123',list_price:7,discount_limit:1,qty_available:9,write_uid:[4,'محمد إياد'],write_date:'2026-10-15 16:00:00'}],'product.product':[]};let calls=[];
 const read=async(model,method,args,kwargs)=>{calls.push([model,method]);if(method==='fields_get')return schema;return products[model].filter(r=>args[0].every(([k,op,v])=>op==='>'?r[k]>v:op==='>='?r[k]>=v:op==='<='?r[k]<=v:true)).slice(0,kwargs.limit).map(r=>Object.fromEntries(kwargs.fields.map(k=>[k,r[k]])));};
 const enqueue=(text)=>{if(fail)throw Error('queue_failed');return String(db.prepare('INSERT INTO queue(text) VALUES(?)').run(text).lastInsertRowid);};
 const make=()=>createProductMonitor({db,read,enabled:()=>true,enqueue,now:()=>time,batchSize:opts.batchSize||2,pagesPerTick:opts.pages||2});let mon=make();
 return {db,products,calls,get mon(){return mon;},restart(){mon=make();},advance(){time+=61000;},fail(v){fail=v;},change(id,values){Object.assign(products['product.template'].find(r=>r.id===id),values,{write_date:new Date(time-3000).toISOString().slice(0,19).replace('T',' ')});},q:()=>db.prepare('SELECT text FROM queue').all()};
}
test('baseline silent, quantity and unchanged save silent, product discount diff identifies latest Odoo writer once',async()=>{
 const f=fixture();await f.mon.tick();assert.equal(f.q().length,0);f.advance();f.change(1,{qty_available:8});await f.mon.tick();assert.equal(f.q().length,0);
 f.advance();f.change(1,{discount_limit:0});await f.mon.tick();assert.equal(f.q().length,1);assert.match(f.q()[0].text,/محمد إياد/);assert.match(f.q()[0].text,/Discount limit/);
 f.advance();await f.mon.tick();assert.equal(f.q().length,1);assert.ok(f.calls.every(([m])=>m.startsWith('product.')));
});
test('atomic queue failure rolls back snapshot and event, next tick delivers once',async()=>{
 const f=fixture();await f.mon.tick();f.advance();f.change(1,{list_price:8});f.fail(true);await f.mon.tick();assert.equal(f.mon.status().lastError,'product_monitor_failed');assert.equal(f.mon.status().events,0);f.fail(false);await f.mon.tick();assert.equal(f.q().length,1);
});
test('pagination survives restart and processes overflow without duplicates',async()=>{
 const f=fixture({batchSize:1,pages:1});f.products['product.template'].push({...f.products['product.template'][0],id:2});await f.mon.tick();await f.mon.tick();await f.mon.tick();f.advance();f.change(1,{list_price:8});f.change(2,{list_price:9});await f.mon.tick();assert.equal(f.mon.status().events,1);f.restart();await f.mon.tick();assert.equal(f.mon.status().events,2);f.advance();await f.mon.tick();assert.equal(f.mon.status().events,2);
});
test('interval does not postpone itself forever; missing actor explicit; new product reported',async()=>{
 const f=fixture();await f.mon.tick();await f.mon.tick();f.advance();f.change(1,{list_price:8,write_uid:false});await f.mon.tick();assert.match(f.q()[0].text,/الاسم غير متاح/);f.advance();f.products['product.template'].push({id:2,name:'جديد',list_price:2,write_date:'2026-10-15 17:02:00'});await f.mon.tick();assert.equal(f.mon.status().events,2);
});
test('reader rejects mutations, other models, auth errors without leaking remote error',async()=>{
 const c=()=>({url:'https://example.com',db:'db',username:'u',apiKey:'secret'});const methods=[];
 const read=createProductReader(c,async(url,init)=>{const p=JSON.parse(init.body).params;methods.push(p.method);return {ok:true,json:async()=>p.service==='common'?{result:5}:{error:{data:'private credential text'}}};});
 await assert.rejects(read('product.template','write'),/scope_rejected/);await assert.rejects(read('sale.order','search_read'),/scope_rejected/);await assert.rejects(read('product.template','fields_get'),/^Error: odoo_read_rpc_error$/);assert.deepEqual(methods,['authenticate','execute_kw']);
 assert.ok(!('qty_available' in productFields(schema)));assert.ok(!('computed_discount' in productFields(schema)));
});
