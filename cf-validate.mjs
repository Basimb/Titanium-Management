import fs from 'node:fs'; import https from 'node:https'; import { URL } from 'node:url';
const CFG=JSON.parse(fs.readFileSync(process.env.CFG||'/home/titani24/.titanium-team-chat/config.json','utf8'));
const BASE=(CFG.ODOO_URL||'').replace(/\/+$/,''); const DB=CFG.ODOO_DB,USER=CFG.ODOO_USERNAME,KEY=CFG.ODOO_API_KEY;
function rpc(service,method,args){const body=JSON.stringify({jsonrpc:'2.0',method:'call',params:{service,method,args}});const u=new URL(BASE+'/jsonrpc');
  return new Promise((res,rej)=>{const q=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname||'/jsonrpc',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{let d='';r.setEncoding('utf8');r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);j.error?rej(new Error(JSON.stringify(j.error))):res(j.result);}catch(e){rej(e);}});});q.on('error',rej);q.setTimeout(90000,()=>q.destroy(new Error('timeout')));q.write(body);q.end();});}
const pname=pid=>Array.isArray(pid)?String(pid[1]):'';
const acode=a=>Array.isArray(a)?(String(a[1]).match(/^\d+/)||[])[0]:'';
const mi=d=>{const m=String(d||'').match(/^\d{4}-(\d{2})/);return m?(+m[1]-1):-1;};
function cat(code,pn){
  if(!code) return ['out','أخرى نقدية'];
  if(code==='210501') return ['out','شراء صيدلية دابوق (رند)'];
  if(code==='110102'||code==='110103'||code==='110106'||code==='110104') return ['out','إيداعات/تحويلات بنكية'];
  if(code==='610001'||code==='210301') return ['out','الرواتب والأجور'];
  if(code==='610002') return ['out','الضمان الاجتماعي'];
  if(code==='610003') return ['out','إضافي وعلاوات'];
  if(code==='610004') return ['out','عمولات بيع للعاملين'];
  if(code==='610005') return ['out','تدريب'];
  if(code==='620001') return ['out','إيجارات'];
  if(/^62/.test(code)) return ['out','مصاريف تشغيلية'];
  if(/^63/.test(code)) return ['out','مصاريف تشغيلية'];
  if(/^64/.test(code)) return ['out','مصاريف بنكية/فروقات'];
  if(code==='210101') return ['out', /شادي|رند/.test(pn||'')?'شراء صيدلية دابوق (رند)':'موردون أدوية'];
  if(code==='210102') return ['out','شيكات آجلة (صرف)'];
  if(code==='110205') return ['out','سلف/ذمم موظفين'];
  if(code==='110202'||code==='110204') return ['in','تحصيل تأمين'];
  if(code==='110201') return ['in','ذمم عملاء/عيادات'];
  if(code==='110100'||/^1103/.test(code)) return ['skip','مخزون'];
  if(/^51/.test(code)) return ['skip','كلفة/جرد'];
  if(/^2104/.test(code)) return ['out','جاري شركاء/علاقة'];
  if(/^42/.test(code)) return ['in','أرباح متفرقة'];
  return ['out','أخرى نقدية'];
}
const uid=await rpc('common','authenticate',[DB,USER,KEY,{}]);
const CASH=['110101']; const YS='2026-01-01',YE='2026-12-31';
const cashL=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['account_id.code','in',CASH],['parent_state','=','posted'],['date','>=',YS],['date','<=',YE]],['move_id']],{limit:20000}]);
const mids=[...new Set(cashL.map(l=>l.move_id&&l.move_id[0]).filter(Boolean))];
const AL=[]; for(let i=0;i<mids.length;i+=200){const part=mids.slice(i,i+200);const r=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['move_id','in',part],['parent_state','=','posted']],['move_id','account_id','debit','credit','date','partner_id']],{limit:60000}]);AL.push(...r);}
const byMove={}; for(const l of AL){const m=l.move_id[0];(byMove[m]=byMove[m]||[]).push(l);}
const isC=c=>CASH.indexOf(c)>=0;
const OUT={},IN={}; const add=(bag,n,m,v)=>{if(m<0)return;(bag[n]=bag[n]||Array(12).fill(0))[m]+=v;};
for(const m in byMove){const ls=byMove[m];let co=0,ci=0,mo=-1;
  for(const l of ls){const c=acode(l.account_id);if(isC(c)){co+=l.credit||0;ci+=l.debit||0;if(mo<0)mo=mi(l.date);}}
  const oth=ls.filter(l=>!isC(acode(l.account_id)));
  const dt=oth.reduce((s,l)=>s+(l.debit||0),0), ct=oth.reduce((s,l)=>s+(l.credit||0),0);
  if(co>0.001&&dt>0.001)for(const l of oth){if(!(l.debit>0))continue;const[di,nm]=cat(acode(l.account_id),pname(l.partner_id));if(di==='skip')continue;add(di==='in'?IN:OUT,nm,mo,co*(l.debit/dt));}
  if(ci>0.001&&ct>0.001)for(const l of oth){if(!(l.credit>0))continue;const[di,nm]=cat(acode(l.account_id),pname(l.partner_id));if(di==='skip')continue;add('in'===di?IN:IN,nm,mo,ci*(l.credit/ct));}
}
const r3=v=>Math.round(v*1000)/1000;
const SEP=8;
let outT=0; console.log('=== صندوق — خارج أيلول (مصنّف) ===');
for(const n of Object.keys(OUT).sort((a,b)=>OUT[b][SEP]-OUT[a][SEP])){const v=OUT[n][SEP];if(Math.abs(v)<0.5)continue;console.log(r3(v).toString().padStart(10),'|',n);outT+=v;}
console.log('مجموع الخارج أيلول =', r3(outT), '(أودو=37599.082)');
let inT=0; console.log('=== صندوق — داخل أيلول ===');
for(const n of Object.keys(IN).sort((a,b)=>IN[b][SEP]-IN[a][SEP])){const v=IN[n][SEP];if(Math.abs(v)<0.5)continue;console.log(r3(v).toString().padStart(10),'|',n);inT+=v;}
console.log('مجموع الداخل أيلول =', r3(inT), '(أودو=40375.623)');
console.log('دابوق أيلول =', r3((OUT['شراء صيدلية دابوق (رند)']||[])[SEP]||0));
