import fs from 'node:fs'; import https from 'node:https'; import { URL } from 'node:url';
const CFG=JSON.parse(fs.readFileSync(process.env.CFG||'/home/titani24/.titanium-team-chat/config.json','utf8'));
const BASE=(CFG.ODOO_URL||'').replace(/\/+$/,''); const DB=CFG.ODOO_DB,USER=CFG.ODOO_USERNAME,KEY=CFG.ODOO_API_KEY;
function rpc(s,m,a){const b=JSON.stringify({jsonrpc:'2.0',method:'call',params:{service:s,method:m,args:a}});const u=new URL(BASE+'/jsonrpc');
  return new Promise((res,rej)=>{const q=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname||'/jsonrpc',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},r=>{let d='';r.setEncoding('utf8');r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);j.error?rej(new Error(JSON.stringify(j.error))):res(j.result);}catch(e){rej(e);}});});q.on('error',rej);q.setTimeout(120000,()=>q.destroy(new Error('timeout')));q.write(b);q.end();});}
const pname=p=>Array.isArray(p)?String(p[1]):'';
const acode=a=>Array.isArray(a)?(String(a[1]).match(/^\d+/)||[])[0]:'';
const mi=d=>{const m=String(d||'').match(/^\d{4}-(\d{2})/);return m?(+m[1]-1):-1;};
const r3=v=>Math.round(v*1000)/1000;
// تصنيف الطرف المقابل حسب الحساب النقدي (box=صندوق, bank=بنك)
function catIn(acc,code){ // الكاش الداخل: الطرف دائن
  if(code==='110202'||code==='110204') return acc==='box'?'مبيعات كاش':'تحصيل تأمين';
  if(code==='110104') return acc==='bank'?'تحصيل فيزا':'تحويل من فيزا';
  if(code==='110201') return 'دخل العيادات';
  if(code==='110101'||code==='110103'||code==='110106') return 'تحويلات داخلية (وارد)';
  if(/^42/.test(code)) return 'أرباح/تسويات';
  if(code==='210401'||code==='210404'||code==='210405') return 'جاري شركاء (وارد)';
  return 'متحصلات أخرى';
}
function catOut(acc,code,pn){ // الكاش الخارج: الطرف مدين
  if(code==='210501') return 'شراء صيدلية دابوق (رند)';
  if(code==='210101') return /شادي|رند/.test(pn||'')?'شراء صيدلية دابوق (رند)':'موردون أدوية (كاش)';
  if(code==='210102') return 'شيكات آجلة (صرف)';
  if(code==='610001'||code==='210301') return 'الرواتب والأجور';
  if(code==='610002') return 'الضمان الاجتماعي';
  if(code==='610003') return 'إضافي وعلاوات ومكافآت';
  if(code==='610004') return 'عمولات بيع للعاملين';
  if(code==='610005') return 'تدريب';
  if(code==='620001') return 'إيجارات';
  if(/^62/.test(code)) return 'مصاريف تشغيلية';
  if(/^63/.test(code)) return 'مصاريف تشغيلية';
  if(/^64/.test(code)) return 'مصاريف بنكية/فروقات';
  if(code==='110205') return 'سلف/ذمم موظفين';
  if(code==='110102'||code==='110103'||code==='110106') return 'إيداعات/تحويلات بنكية';
  if(code==='110104') return 'تحويل لفيزا';
  if(code==='210401'||code==='210404'||code==='210405') return 'جاري شركاء (صادر)';
  if(code==='110100'||/^1103/.test(code)||/^51/.test(code)) return 'SKIP';
  if(code==='110201') return 'ذمم عملاء (صادر)';
  return 'أخرى نقدية';
}
async function flowsFor(accCode, tag){
  const cashL=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['account_id.code','=',accCode],['parent_state','=','posted'],['date','>=','2026-01-01'],['date','<=','2026-12-31']],['move_id']],{limit:40000}]);
  const mids=[...new Set(cashL.map(l=>l.move_id&&l.move_id[0]).filter(Boolean))];
  const byMove={};
  for(let i=0;i<mids.length;i+=200){const part=mids.slice(i,i+200);const r=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['move_id','in',part],['parent_state','=','posted']],['move_id','account_id','debit','credit','date','partner_id']],{limit:80000}]);for(const l of r){const m=l.move_id[0];(byMove[m]=byMove[m]||[]).push(l);}}
  const IN={},OUT={}; const add=(bag,n,m,v)=>{if(m<0)return;(bag[n]=bag[n]||Array(12).fill(0))[m]+=v;};
  const realNet=Array(12).fill(0);
  for(const m in byMove){const ls=byMove[m];let co=0,ci=0,mo=-1;
    for(const l of ls){if(acode(l.account_id)===accCode){co+=l.credit||0;ci+=l.debit||0;if(mo<0)mo=mi(l.date);}}
    if(mo>=0)realNet[mo]+=ci-co;
    const oth=ls.filter(l=>acode(l.account_id)!==accCode);
    const dt=oth.reduce((s,l)=>s+(l.debit||0),0),ct=oth.reduce((s,l)=>s+(l.credit||0),0);
    if(co>0.001&&dt>0.001)for(const l of oth){if(!(l.debit>0))continue;const nm=catOut(tag,acode(l.account_id),pname(l.partner_id));if(nm==='SKIP')continue;add(OUT,nm,mo,co*(l.debit/dt));}
    if(ci>0.001&&ct>0.001)for(const l of oth){if(!(l.credit>0))continue;const nm=catIn(tag,acode(l.account_id));add(IN,nm,mo,ci*(l.credit/ct));}
  }
  // سطر تسوية لضمان المطابقة
  const resid=Array(12).fill(0);
  for(let m=0;m<12;m++){let s=0;for(const n in IN)s+=IN[n][m];for(const n in OUT)s-=OUT[n][m];resid[m]=r3(realNet[m]-s);}
  return {IN,OUT,realNet:realNet.map(r3),resid};
}
const uid=await rpc('common','authenticate',[DB,USER,KEY,{}]);
const box=await flowsFor('110101','box');
const bank=await flowsFor('110102','bank');
const SEP=8;
function dump(tag,f){console.log('\n===== '+tag+' — أيلول =====');
  let din=0,dout=0;
  console.log('— داخل —');for(const n of Object.keys(f.IN).sort((a,b)=>f.IN[b][SEP]-f.IN[a][SEP])){const v=f.IN[n][SEP];if(Math.abs(v)<0.5)continue;console.log(r3(v).toString().padStart(11),'|',n);din+=v;}
  console.log('— خارج —');for(const n of Object.keys(f.OUT).sort((a,b)=>f.OUT[b][SEP]-f.OUT[a][SEP])){const v=f.OUT[n][SEP];if(Math.abs(v)<0.5)continue;console.log(r3(v).toString().padStart(11),'|',n);dout+=v;}
  console.log('تسوية غير مفصّلة =',f.resid[SEP]);
  console.log('صافي محسوب =',r3(din-dout+f.resid[SEP]),'| صافي أودو =',f.realNet[SEP]);
}
dump('الصندوق',box); dump('البنك',bank);
console.log('\nدابوق(صندوق) أيلول =', r3((box.OUT['شراء صيدلية دابوق (رند)']||[])[SEP]||0));
