// وحدة حساب الحركة النقدية الشهرية من أودو (تُستورد من cf-build) — توزيع كل حركة صندوق/بنك على الحساب المقابل + سطر تسوية
// يدعم وضعين: كامل (كل السنة) وخفيف (الشهر الحالي فقط + دمج مع تاريخ مجمّد سابق)
const pn_=p=>Array.isArray(p)?String(p[1]):'';
const ac_=a=>Array.isArray(a)?(String(a[1]).match(/^\d+/)||[])[0]:'';
const mo_=d=>{const m=String(d||'').match(/^\d{4}-(\d{2})/);return m?(+m[1]-1):-1;};
const rr=v=>Math.round(v*1000)/1000;
// بنود تُحسب بقيمتها الكاملة (بلا توزيع تناسبي) حتى تظهر صحيحة متل ما هي بأودو
const DIRECT=new Set(['شراء صيدلية دابوق (رند)']);
function catIn(acc,code){
  if(code==='110202'||code==='110204') return acc==='box'?'مبيعات كاش':'تحصيل تأمين';
  if(code==='110104') return acc==='bank'?'تحصيل فيزا':'تحويل من فيزا';
  if(code==='110201') return 'دخل العيادات';
  if(code==='110101'||code==='110103'||code==='110106') return 'تحويلات داخلية (وارد)';
  if(/^42/.test(code)) return 'أرباح/تسويات';
  if(code==='210401'||code==='210404'||code==='210405') return 'جاري شركاء (وارد)';
  return 'متحصلات أخرى';
}
// خريطة حسابات المصاريف → بنود الكشف (من شجرة حسابات أودو)
const OUTMAP={
  '610001':'الرواتب والأجور','210301':'الرواتب والأجور',
  '610002':'الضمان الاجتماعي',
  '610003':'إضافي وعلاوات ومكافآت',
  '610004':'عمولات بيع للعاملين',
  '610005':'تدريب',
  '620002':'كهرباء','620003':'مياه','620004':'صيانة وإصلاح','620005':'نظافة','620006':'ديكورات غير رأسمالية',
  '630001':'هاتف وإنترنت','630002':'قرطاسية ومطبوعات','630003':'أكياس ومواد تعبئة','630004':'ضيافة',
  '630005':'نقل وتنقلات','630006':'سفر','630007':'رسوم مزاولة المهنة','630008':'رسوم ورخص حكومية',
  '630009':'تأمين','630010':'برامج وأنظمة محاسبية','630011':'مصاريف كمبيوتر','630012':'أتعاب محاماة',
  '630013':'أتعاب تدقيق واستشارات','630014':'دعاية وإعلان','630098':'مصاريف متفرقة','630099':'مصاريف متفرقة',
  '640001':'مصاريف بنكية','640002':'فوائد وعمولات بنكية','640003':'عمولات البطاقات - الفيزا',
  '640004':'فروقات الصندوق','640005':'فروقات الصندوق','640006':'فروقات عملة','640007':'عمولات تحويل ودفع إلكتروني',
};
// تقسيم الإيجارات حسب المؤجّر
function rentName(pn,memo){
  const p=(pn||'')+' '+(memo||'');
  if(/موسى|ناعور/.test(p)) return 'إيجار ناعور';
  if(/سميح|صافوط/.test(p)) return 'إيجار صافوط';
  if(/ليمار|دابوق|رند/.test(p)) return 'إيجار دابوق';
  if(/جمرك/.test(p)) return 'إيجار الجمرك';
  if(/عياد|محمود|فادي/.test(p)) return 'إيجار العيادات';
  return 'إيجارات أخرى';
}
function catOut(acc,code,pn,memo){
  if(code==='210501') return 'شراء صيدلية دابوق (رند)';
  if(code==='210101') return /شادي|رند/.test(pn||'')?'شراء صيدلية دابوق (رند)':'موردون أدوية (كاش)';
  if(code==='210102') return 'شيكات آجلة (صرف)';
  if(code==='620001') return rentName(pn,memo);
  if(OUTMAP[code]) return OUTMAP[code];
  if(/^65/.test(code)) return 'استهلاكات';
  if(code==='110205'){const _m=memo||'';if(/عمول/.test(_m))return 'عمولات بيع للعاملين';if(/مزاول/.test(_m))return 'رسوم مزاولة المهنة';if(/علاوة|مكافأ|مكافا|اضافي|إضافي/.test(_m))return 'إضافي وعلاوات ومكافآت';if(/راتب|رواتب/.test(_m))return /متأخر|متاخر|202[0-5]/.test(_m)?'رواتب متأخرة':'الرواتب والأجور';return 'سلف/ذمم موظفين';}
  if(code==='110102'||code==='110103'||code==='110106') return 'إيداعات/تحويلات بنكية';
  if(code==='110104') return 'تحويل لفيزا';
  if(code==='210401'||code==='210404'||code==='210405') return 'جاري شركاء (صادر)';
  if(code==='110100'||/^1103/.test(code)||/^51/.test(code)) return 'SKIP';
  if(code==='110201') return 'ذمم عملاء (صادر)';
  const _mm=memo||'';
  if(/كهرباء/.test(_mm)) return 'كهرباء';
  if(/مياه|فاتورة ماء/.test(_mm)) return 'مياه';
  if(/رواتب|راتب/.test(_mm)&&!/سلف/.test(_mm)) return /متأخر|متاخر|202[0-5]/.test(_mm)?'رواتب متأخرة':'الرواتب والأجور';
  if(/ايجار|إيجار/.test(_mm)) return rentName(pn,memo);
  if(/صيانة|اصلاح|إصلاح/.test(_mm)) return 'صيانة وإصلاح';
  if(/نظافة/.test(_mm)) return 'نظافة';
  if(/هاتف|انترنت|إنترنت/.test(_mm)) return 'هاتف وإنترنت';
  if(/قرطاسية|مطبوعات/.test(_mm)) return 'قرطاسية ومطبوعات';
  if(/ضيافة/.test(_mm)) return 'ضيافة';
  if(/نقل|تنقل|مواصلات/.test(_mm)) return 'نقل وتنقلات';
  return 'أخرى نقدية';
}
async function flowsFor(rpc,uid,DB,KEY,accCode,tag,dateFrom,detCat,detMonth){
  const from=dateFrom||'2026-01-01';
  const cashL=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['account_id.code','=',accCode],['parent_state','=','posted'],['date','>=',from],['date','<=','2026-12-31']],['move_id']],{limit:40000}]);
  const mids=[...new Set(cashL.map(l=>l.move_id&&l.move_id[0]).filter(Boolean))];
  const byMove={};
  for(let i=0;i<mids.length;i+=200){const part=mids.slice(i,i+200);const r=await rpc('object','execute_kw',[DB,uid,KEY,'account.move.line','search_read',[[['move_id','in',part],['parent_state','=','posted']],['move_id','account_id','debit','credit','date','partner_id','name']],{limit:80000}]);for(const l of r){const m=l.move_id[0];(byMove[m]=byMove[m]||[]).push(l);}}
  // كشف أزواج «الغسيل»: دخول كاش على ذمة (110201/110202/110205) + طلوع كاش على فروقات الصندوق (640004/640005) بنفس المبلغ ونفس اليوم — تصفية ذمم مرّت على الصندوق غلط، تُشال من الطرفين
  const washIds=new Set();
  {const rcv=new Set(['110201','110202','110205']),frq=new Set(['640004','640005']),recvIn={},farqOut={};
    for(const m in byMove){const ls=byMove[m];let cD=0,cC=0,dt='';for(const l of ls){if(ac_(l.account_id)===accCode){cD+=l.debit||0;cC+=l.credit||0;dt=String(l.date||'').slice(0,10);}}
      const oth=ls.filter(l=>ac_(l.account_id)!==accCode);
      if(cD>=20&&oth.length&&oth.every(l=>rcv.has(ac_(l.account_id)))){const k=dt+'|'+Math.round(cD*1000);(recvIn[k]=recvIn[k]||[]).push(m);}
      if(cC>=20&&oth.some(l=>frq.has(ac_(l.account_id)))){const k=dt+'|'+Math.round(cC*1000);(farqOut[k]=farqOut[k]||[]).push(m);}}
    for(const k in farqOut){if(recvIn[k]){farqOut[k].forEach(id=>washIds.add(id));recvIn[k].forEach(id=>washIds.add(id));}}}
  const IN={},OUT={}; const add=(bag,n,m,v)=>{if(m<0)return;(bag[n]=bag[n]||Array(12).fill(0))[m]+=v;}; const detBag={};
  const realNet=Array(12).fill(0);
  for(const m in byMove){if(washIds.has(m))continue;const ls=byMove[m];let co=0,ci=0,mm=-1;
    for(const l of ls){if(ac_(l.account_id)===accCode){co+=l.credit||0;ci+=l.debit||0;if(mm<0)mm=mo_(l.date);}}
    if(mm>=0)realNet[mm]+=ci-co;
    const oth=ls.filter(l=>ac_(l.account_id)!==accCode);
    const ct=oth.reduce((s,l)=>s+(l.credit||0),0);
    if(co>0.001){
      const _sm=ls.filter(x=>ac_(x.account_id)===accCode).map(x=>x.name||'').join(' ');
      const _mo=l=>((l.name||'')+' '+_sm);
      const outl=oth.filter(l=>l.debit>0&&catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))!=='SKIP');
      const dir=outl.filter(l=>DIRECT.has(catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))));
      const reg=outl.filter(l=>!DIRECT.has(catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))));
      let dsum=0;
      for(const l of dir){const nm=catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l));add(OUT,nm,mm,l.debit);dsum+=l.debit;if(detCat&&nm===detCat&&mm===detMonth){const _pp=pn_(l.partner_id)||'غير محدد';detBag[_pp]=(detBag[_pp]||0)+l.debit;}}
      const regdt=reg.reduce((s,l)=>s+l.debit,0),corest=co-dsum;
      if(corest>0.001&&regdt>0.001)for(const l of reg){const nm=catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l));const _av=corest*(l.debit/regdt);add(OUT,nm,mm,_av);if(detCat&&nm===detCat&&mm===detMonth){const _pp=pn_(l.partner_id)||'غير محدد';detBag[_pp]=(detBag[_pp]||0)+_av;}}
    }
    if(ci>0.001&&ct>0.001)for(const l of oth){if(!(l.credit>0))continue;const nm=catIn(tag,ac_(l.account_id));add(IN,nm,mm,ci*(l.credit/ct));}
  }
  const R=o=>{const x={};for(const k in o)x[k]=o[k].map(rr);return x;};
  const resid=Array(12).fill(0);
  for(let m=0;m<12;m++){let s=0;for(const n in IN)s+=IN[n][m];for(const n in OUT)s-=OUT[n][m];resid[m]=rr(realNet[m]-s);}
  return {IN:R(IN),OUT:R(OUT),realNet:realNet.map(rr),resid,det:detBag};
}
// دمج: خذ التاريخ المجمّد (prev) واستبدل فقط عمود الشهر الحالي (li) بالمحسوب الطازج
function mergeMonth(prev,fresh,li){
  const out={IN:{},OUT:{},realNet:(prev.realNet||Array(12).fill(0)).slice(),resid:(prev.resid||Array(12).fill(0)).slice()};
  for(const side of ['IN','OUT']){
    const cats=new Set([...Object.keys(prev[side]||{}),...Object.keys(fresh[side]||{})]);
    for(const c of cats){
      const a=((prev[side]||{})[c]||Array(12).fill(0)).slice();
      a[li]=(((fresh[side]||{})[c])&&fresh[side][c][li])||0;
      out[side][c]=a.map(rr);
    }
  }
  out.realNet[li]=rr((fresh.realNet&&fresh.realNet[li])||0);
  out.resid[li]=rr((fresh.resid&&fresh.resid[li])||0);
  return out;
}
const _mdet=(a,b)=>{const o={};for(const k in (a||{}))o[k]=(o[k]||0)+a[k];for(const k in (b||{}))o[k]=(o[k]||0)+b[k];return o;};
export async function computeMonthly(rpc,uid,DB,KEY,opts){
  opts=opts||{};
  if(opts.light && opts.prev && opts.prev.box && opts.prev.bank && !opts.prev.error && typeof opts.liveIdx==='number'){
    const from=opts.liveStart||'2026-01-01';
    const boxF=await flowsFor(rpc,uid,DB,KEY,'110101','box',from,'الرواتب والأجور',opts.liveIdx);
    const bankF=await flowsFor(rpc,uid,DB,KEY,'110102','bank',from,'الرواتب والأجور',opts.liveIdx);
    return {box:mergeMonth(opts.prev.box,boxF,opts.liveIdx), bank:mergeMonth(opts.prev.bank,bankF,opts.liveIdx), det:_mdet(boxF.det,bankF.det), light:true};
  }
  const _li=(typeof opts.liveIdx==='number')?opts.liveIdx:-1;
  const box=await flowsFor(rpc,uid,DB,KEY,'110101','box',undefined,'الرواتب والأجور',_li);
  const bank=await flowsFor(rpc,uid,DB,KEY,'110102','bank',undefined,'الرواتب والأجور',_li);
  return {box,bank,det:_mdet(box.det,bank.det)};
}
