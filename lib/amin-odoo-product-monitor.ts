import type {DatabaseSync} from 'node:sqlite';
import {writeFileSync,renameSync} from 'node:fs';

const MODELS=['product.template','product.product'];
const BASE:Record<string,string>={name:'اسم المادة',default_code:'الرمز الداخلي',barcode:'الباركود',list_price:'سعر البيع',standard_price:'التكلفة',categ_id:'التصنيف',uom_id:'وحدة البيع',uom_po_id:'وحدة الشراء',sale_ok:'متاح للبيع',purchase_ok:'متاح للشراء',active:'الأرشفة',taxes_id:'ضرائب البيع',supplier_taxes_id:'ضرائب الشراء',description_sale:'وصف البيع'};
const clean=(v:unknown,n=100)=>String(v??'').replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,n);
export function productFields(schema:Record<string,any>){
 const fields:Record<string,string>={};
 for(const [name,f]of Object.entries(schema)){
  if(BASE[name])fields[name]=BASE[name];
  else if(f.store!==false&&!f.readonly&&/discount/i.test(name)&&['boolean','float','integer','selection','char'].includes(f.type))fields[name]='إعداد الخصم: '+clean(f.string||name,70);
 }
 return fields;
}
function stable(v:any):any{return Array.isArray(v)?(v.every(x=>typeof x==='number')?[...v].sort((a,b)=>a-b):v.map(stable)):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;}
const encode=(v:any)=>JSON.stringify(stable(v));
function value(v:any){if(v===true)return 'نعم';if(v===false||v===null||v===undefined)return 'بدون';if(Array.isArray(v)&&v.length===2&&typeof v[1]==='string')return clean(v[1],80);return clean(typeof v==='object'?JSON.stringify(v):v,80);}

/** Strictly read-only Odoo adapter: no arbitrary model or mutation methods. */
export function createProductReader(config:()=>{url:string;db:string;username:string;apiKey:string},fetcher:typeof fetch=fetch){
 let uid=0;
 async function rpc(service:string,method:string,args:any[]){
  const c=config();if(!/^https:\/\/[\w.-]+$/.test(c.url)||!c.db||!c.username||!c.apiKey)throw Error('odoo_config_unavailable');
  let r;try{r=await fetcher(c.url+'/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify({jsonrpc:'2.0',method:'call',params:{service,method,args},id:1})});}catch{throw Error('odoo_read_unreachable');}
  if(!r.ok)throw Error('odoo_read_http_error');let j;try{j=await r.json();}catch{throw Error('odoo_read_invalid_json');}
  if(j.error){uid=0;throw Error('odoo_read_rpc_error');}return j.result;
 }
 return async(model:string,method:string,args:any[]=[],kwargs:any={})=>{
  if(!MODELS.includes(model)||!['fields_get','search_read'].includes(method))throw Error('odoo_read_scope_rejected');
  const c=config();if(!uid){uid=Number(await rpc('common','authenticate',[c.db,c.username,c.apiKey,{}]));if(!Number.isInteger(uid)||uid<=0){uid=0;throw Error('odoo_read_auth_failed');}}
  return rpc('object','execute_kw',[c.db,uid,c.apiKey,model,method,args,kwargs]);
 };
}

/** Snapshot differences, not a universal Odoo audit trail. Latest writer is labelled as such. */
export function createProductMonitor(o:{db:DatabaseSync;read:ReturnType<typeof createProductReader>;enabled:()=>boolean;enqueue:(text:string,at:number)=>string;now?:()=>number;statusPath?:string;batchSize?:number;pagesPerTick?:number}){
 const db=o.db,now=o.now||Date.now,batch=o.batchSize||1000,pages=o.pagesPerTick||8;
 db.exec(`CREATE TABLE IF NOT EXISTS amin_product_watch_state(model TEXT PRIMARY KEY,stage TEXT NOT NULL,last_id INTEGER NOT NULL,since TEXT NOT NULL,fields TEXT NOT NULL,delta_id INTEGER NOT NULL DEFAULT 0,delta_until TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS amin_product_snapshots(model TEXT NOT NULL,id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(model,id));
 CREATE TABLE IF NOT EXISTS amin_product_events(id INTEGER PRIMARY KEY,model TEXT NOT NULL,product_id INTEGER NOT NULL,observed_at INTEGER NOT NULL,write_date TEXT,writer TEXT,changes TEXT NOT NULL,outbox_id TEXT NOT NULL);`);
 let busy=false,stopped=false,lastError:string|null=null,lastCheck=0,lastPoll=0;
 const status=()=>({version:1,lastCheck,lastError,busy,models:db.prepare('SELECT model,stage,last_id FROM amin_product_watch_state').all(),baselineRows:(db.prepare('SELECT count(*) n FROM amin_product_snapshots').get() as any).n,events:(db.prepare('SELECT count(*) n FROM amin_product_events').get() as any).n,coverage:'product template and variants; selected card and writable scalar discount fields; snapshot differences; latest Odoo writer; no sales/stock quantities; no deletion audit'});
 function saveStatus(){if(!o.statusPath)return;try{writeFileSync(o.statusPath+'.tmp',JSON.stringify(status()),{mode:0o600});renameSync(o.statusPath+'.tmp',o.statusPath);}catch{/* status export must not stop monitoring */}}
 function apply(model:string,rows:any[],fields:Record<string,string>,baseline:boolean){
  db.exec('BEGIN IMMEDIATE');try{
   const changed:Array<{row:any;diff:any[];data:string}>=[];
   for(const row of rows){
    if(!Number.isInteger(row.id))throw Error('odoo_invalid_product');
    const data=Object.fromEntries(Object.keys(fields).map(k=>[k,row[k]??null]));const old=db.prepare('SELECT data FROM amin_product_snapshots WHERE model=? AND id=?').get(model,row.id) as any;
    const diffs=old?Object.keys(fields).filter(k=>encode(JSON.parse(old.data)[k])!==encode(data[k])).map(k=>({field:k,label:fields[k],before:JSON.parse(old.data)[k],after:data[k]})):[];
    if(!baseline&&(diffs.length||!old))changed.push({row,diff:diffs,data:encode(data)});
    db.prepare('INSERT OR REPLACE INTO amin_product_snapshots VALUES(?,?,?)').run(model,row.id,encode(data));
   }
   // One private owner message per batch, capped to fit the delivery queue; all differences remain in local audit.
   if(changed.length){
    const lines=changed.slice(0,8).map(({row,diff})=>'• '+clean(row.name||row.display_name||'#'+row.id,95)+'\n  آخر حفظ بأودو: '+(Array.isArray(row.write_uid)?clean(row.write_uid[1],70):'الاسم غير متاح')+'؛ '+clean(row.write_date,25)+' UTC\n  '+(diff.length?diff.slice(0,3).map(d=>d.label+': '+value(d.before)+' ← '+value(d.after)).join('؛ '):'مادة جديدة رُصدت بعد بدء المتابعة.'));
    const text='🛡️ أمين — تغييرات مواد بدواء تك\n'+lines.join('\n')+(changed.length>8?'\n• تفاصيل '+(changed.length-8)+' مواد إضافية محفوظة بسجل أمين.':'')+'\nالمقارنة منذ آخر رصد؛ الاسم لآخر حفظ، وقد تتخلله تعديلات أخرى.';
    const outbox=o.enqueue(text.slice(0,3700),now());
    for(const e of changed)db.prepare('INSERT INTO amin_product_events(model,product_id,observed_at,write_date,writer,changes,outbox_id) VALUES(?,?,?,?,?,?,?)').run(model,e.row.id,now(),e.row.write_date||'',Array.isArray(e.row.write_uid)?clean(e.row.write_uid[1]):'',JSON.stringify(e.diff),outbox);
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 return {status,stop(){stopped=true;},async tick(){
  if(busy||stopped||!o.enabled())return;busy=true;
  let didPoll=false;try{
   for(const model of MODELS){
    if(stopped)break;
    let state=db.prepare('SELECT * FROM amin_product_watch_state WHERE model=?').get(model) as any;
    if(!state){const schema=await o.read(model,'fields_get',[],{attributes:['string','type','store','readonly']});const fields=productFields(schema);if(!fields.name)throw Error('odoo_product_fields_unavailable');
     db.prepare('INSERT INTO amin_product_watch_state(model,stage,last_id,since,fields) VALUES(?,?,?,?,?)').run(model,'baseline',0,new Date(now()-2000).toISOString().slice(0,19).replace('T',' '),JSON.stringify(fields));state=db.prepare('SELECT * FROM amin_product_watch_state WHERE model=?').get(model);}
    const fields=JSON.parse(state.fields),readFields=[...Object.keys(fields),'id','write_uid','write_date'];
    if(state.stage==='baseline'){
     for(let p=0;p<pages&&!stopped;p++){
      const rows=await o.read(model,'search_read',[[['id','>',state.last_id]]],{fields:readFields,order:'id asc',limit:batch,context:{active_test:false}});
      if(!Array.isArray(rows))throw Error('odoo_invalid_products');apply(model,rows,fields,true);
      if(rows.length)state.last_id=rows.at(-1).id;
      state.stage=rows.length<batch?'live':'baseline';db.prepare('UPDATE amin_product_watch_state SET last_id=?,stage=? WHERE model=?').run(state.last_id,state.stage,model);
      if(state.stage==='live')break;
     }
    }else if(now()-lastPoll>=60000){
     didPoll=true;
     const until=state.delta_until||new Date(now()-2000).toISOString().slice(0,19).replace('T',' ');let cursor=state.delta_id||0,done=false;
     for(let p=0;p<pages&&!stopped;p++){
      const rows=await o.read(model,'search_read',[[['write_date','>=',state.since],['write_date','<=',until],['id','>',cursor]]],{fields:readFields,order:'id asc',limit:batch,context:{active_test:false}});
      if(!Array.isArray(rows))throw Error('odoo_invalid_products');apply(model,rows,fields,false);
      if(rows.length)cursor=rows.at(-1).id;
      db.prepare('UPDATE amin_product_watch_state SET delta_id=?,delta_until=? WHERE model=?').run(cursor,until,model);
      if(rows.length<batch){done=true;break;}
     }
     // Overflow is replayed with persisted snapshots; no dropped rows and no duplicate messages.
     if(done)db.prepare("UPDATE amin_product_watch_state SET since=?,delta_id=0,delta_until='' WHERE model=?").run(until,model);
    }
   }
   lastError=null;lastCheck=now();if(didPoll)lastPoll=now();
  }catch(e){lastError=e instanceof Error&&/^odoo_[a-z_]+$/.test(e.message)?e.message:'product_monitor_failed';lastCheck=now();}
  finally{busy=false;saveStatus();}
 }};
}
