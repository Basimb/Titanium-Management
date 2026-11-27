// وحدة حساب الحركة النقدية الشهرية من أودو (تُستورد من cf-build) — توزيع كل حركة صندوق/بنك على الحساب المقابل + سطر تسوية
// يدعم وضعين: كامل (كل السنة) وخفيف (الشهر الحالي فقط + دمج مع تاريخ مجمّد سابق)
/* ===== قواعد باسم الثابتة للكاش فلو (27/11/2026) — أي تعديل لازم يحترمها =====
 1. مرتجعات الموردين (قبض على 210101 بالبنك/الصندوق) ما بتدخل الكاش فلو بتاتاً — مكانها حساب المورد. (الأصل بأودو: المرتجع بينربط بفاتورة المورد، مش دفعة على البنك)
 2. تصحيح «كاش ⇄ فيزا» (كاش الصندوق → 110104) بينخصم من «مبيعات كاش» وبيضل بمبيعات البطاقة — ما بينحسب دخل مرتين.
 3. مبيعات البطاقة = يومية البطاقات + تصحيحات الكاش⇄فيزا بس. قيود التسوية اليدوية (يومية عامة) على حساب الفيزا بتروح «متحصلات أخرى وتسويات» (cf-build: تسويات حساب الفيزا).
 4. عجز الوردية بيظهر بـ«فروقات الصندوق» باسم الوردية وصاحبها. رجوع كاش من 640004/640005 (تصحيح عجز) بيقلّل نفس السطر. عجز انعكس بقيد عكسي بنفس المبلغ خلال 15 يوم بينشال الاثنين.
 5. عجز انحمّل على موظف (110205) = «سلف/ذمم موظفين» وبيتوضح «عجز وردية … — على فلان».
 6. 210406 = «جاري العيادات (صادر)». 110107 (فكّة الفروع) = تحويل داخلي مش مصروف.
 7. «أخرى نقدية» بقائمة منسدلة حسب الحساب بأودو، والمصاريف (62/63) مقسومة على الفروع — من شهر 11 وطالع.
 8. قائمة القيود تحت كل بند: البيان بس (بلا رقم قيد/طرف/«كاش فرع»/تاريخ — هدول بالتلميح)، وأي رقم تحت الدينار ما بينعرض.
================================================================================ */
const pn_=p=>Array.isArray(p)?String(p[1]):'';
const ac_=a=>Array.isArray(a)?(String(a[1]).match(/^\d+/)||[])[0]:'';
const mo_=d=>{const m=String(d||'').match(/^\d{4}-(\d{2})/);return m?(+m[1]-1):-1;};
const rr=v=>Math.round(v*1000)/1000;
// 19/11/2026 باسم: قيود تجارب تطلع من الكاش فلو كله (قبض ذمة 10 انسجل مرتين 17/11 وعكسهم: CSH1/2026/01513 + 01514 + 01516 + 01526) — القيود بأودو ما انلمست
export const SKIP_MOVES=new Set([520549,520550,520552,521088]);
// بنود تُحسب بقيمتها الكاملة (بلا توزيع تناسبي) حتى تظهر صحيحة متل ما هي بأودو
const DIRECT=new Set(['شراء صيدلية دابوق (رند)']);
// بنود كبيرة/داخلية ما بنطلع قيودها بالقائمة المنسدلة
const NOENT=new Set(['مبيعات كاش','تحصيل فيزا','تحصيل تأمين','تحويلات داخلية (وارد)','تحويل من فيزا','إيداعات/تحويلات بنكية','تحويل لفيزا','SKIP']);
// 27/11 باسم: بيان القيد بالقائمة = البيان بس (بلا رقم القيد والطرف المكرر)، والعجز يوضح إنه عجز وردية ومين
function entLbl(l,ses){let m=String(l.name||'').trim();const p=pn_(l.partner_id);
  const sx=ses?(' '+ses[0]+(ses[1]?' — '+ses[1].split(/\s+/).slice(0,2).join(' '):'')):'';
  if(/Cash difference.*\(Loss\)/i.test(m))return 'عجز وردية'+sx;
  if(/Cash difference.*\(Profit\)/i.test(m))return 'زيادة وردية'+sx;
  if(/Vendor Reimbursement/i.test(m))return 'مرتجع'+(p?' — '+p:'');
  if(/عجز/.test(m)&&!/تصحيح/.test(m)){const s=(m.match(/POS\/\d+/)||[''])[0];const who=p.replace(/^Mohamed Eid.*/i,'محمد عيد');return ('عجز وردية '+s).trim()+(who?' — على '+who:'');}
  m=m.replace(/\s*-?\s*\d{1,2}-\d{1,2}\s*$/,'').replace(/\s*-?\s*كاش\s+(ناعور|صافوط|الجمرك|جمرك|دابوق)\s*$/,'').trim();return (m||p||'').slice(0,90);}
const _ment=(a,b)=>{const o={};for(const s of [a||{},b||{}])for(const k in s)o[k]=(o[k]||[]).concat(s[k]);for(const k in o)o[k].sort((x,y)=>x[0]<y[0]?-1:(x[0]>y[0]?1:0));return o;};
function catIn(acc,code){
  if(code==='110202'||code==='110204') return acc==='box'?'مبيعات كاش':'تحصيل تأمين';
  if(code==='110104') return acc==='bank'?'تحصيل فيزا':'تحويل من فيزا';
  if(code==='110201') return 'دخل العيادات';
  if(code==='110101'||code==='110102'||code==='110103'||code==='110106') return 'تحويلات داخلية (وارد)';
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
  '630013':'أتعاب تدقيق واستشارات','630014':'دعاية وإعلان','630015':'مصاريف مطالبات التأمين','630098':'مصاريف متفرقة','630099':'مصاريف متفرقة',
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
  if(code==='110101'||code==='110102'||code==='110103'||code==='110106') return 'إيداعات/تحويلات بنكية';
  if(code==='110104') return 'تحويل لفيزا';
  if(code==='110107') return 'إيداعات/تحويلات بنكية'; // 27/11 باسم: فكّة صناديق الفروع = تحويل داخلي مش مصروف
  if(code==='210401'||code==='210404'||code==='210405') return 'جاري شركاء (صادر)';
  if(code==='210406') return 'جاري العيادات (صادر)'; // 27/11 باسم: كاش اندفع عن عيادات تيتانيوم
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
  // 27/11 باسم: عجز/زيادة الإقفال — اسم الوردية وصاحبها (من سطر الصندوق المربوط بالجلسة)
  const sesOf={};
  try{const cd=Object.keys(byMove).filter(m=>byMove[m].some(l=>/Cash difference/i.test(l.name||''))).map(Number);
    if(cd.length){const sl=await rpc('object','execute_kw',[DB,uid,KEY,'account.bank.statement.line','search_read',[[['move_id','in',cd]],['move_id','pos_session_id']],{limit:3000}]);
      const sids=[...new Set(sl.map(x=>x.pos_session_id&&x.pos_session_id[0]).filter(Boolean))];
      const ss=sids.length?await rpc('object','execute_kw',[DB,uid,KEY,'pos.session','read',[sids,['name','user_id']]]):[];const sm={};for(const s of ss)sm[s.id]=[s.name,pn_(s.user_id)];
      for(const x of sl){const s=x.pos_session_id&&sm[x.pos_session_id[0]];if(s&&x.move_id)sesOf[x.move_id[0]]=s;}}}catch(_){}
  // كشف أزواج «الغسيل»: دخول كاش على ذمة (110201/110202/110205) + طلوع كاش على فروقات الصندوق (640004/640005) بنفس المبلغ ونفس اليوم — تصفية ذمم مرّت على الصندوق غلط، تُشال من الطرفين
  const washIds=new Set();
  {const rcv=new Set(['110201','110202','110205']),frq=new Set(['640004','640005']),recvIn={},farqOut={};
    for(const m in byMove){const ls=byMove[m];let cD=0,cC=0,dt='';for(const l of ls){if(ac_(l.account_id)===accCode){cD+=l.debit||0;cC+=l.credit||0;dt=String(l.date||'').slice(0,10);}}
      const oth=ls.filter(l=>ac_(l.account_id)!==accCode);
      if(cD>=20&&oth.length&&oth.every(l=>rcv.has(ac_(l.account_id)))){const k=dt+'|'+Math.round(cD*1000);(recvIn[k]=recvIn[k]||[]).push(m);}
      if(cC>=20&&oth.some(l=>frq.has(ac_(l.account_id)))){const k=dt+'|'+Math.round(cC*1000);(farqOut[k]=farqOut[k]||[]).push(m);}}
    for(const k in farqOut){if(recvIn[k]){farqOut[k].forEach(id=>washIds.add(id));recvIn[k].forEach(id=>washIds.add(id));}}
    // 27/11 باسم: عجز انعكس بقيد عكسي (طلوع كاش على فروقات الصندوق + رجوعه من فروقات الصندوق بنفس المبلغ خلال 15 يوم) — بيتشال الاثنين، مش عجز ومش متحصّل (مثل براءة POS/03563)
    {const fo=[],fi=[];
      for(const m in byMove){if(washIds.has(m))continue;const ls=byMove[m];let cD=0,cC=0,dt='';for(const l of ls){if(ac_(l.account_id)===accCode){cD+=l.debit||0;cC+=l.credit||0;dt=String(l.date||'').slice(0,10);}}
        const oth=ls.filter(l=>ac_(l.account_id)!==accCode);if(!oth.length||!oth.every(l=>frq.has(ac_(l.account_id))))continue;
        if(cC>0.001&&cD<0.001)fo.push([m,Math.round(cC*1000),Date.parse(dt)]);else if(cD>0.001&&cC<0.001)fi.push([m,Math.round(cD*1000),Date.parse(dt)]);}
      const used=new Set();for(const [mi,a,t] of fi){const hit=fo.find(([mo,b,u])=>!used.has(mo)&&b===a&&Math.abs(t-u)<=15*86400000);if(hit){used.add(hit[0]);washIds.add(hit[0]);washIds.add(mi);}}}}
  const IN={},OUT={}; const add=(bag,n,m,v)=>{if(m<0)return;(bag[n]=bag[n]||Array(12).fill(0))[m]+=v;}; const detBag={};
  // 27/11 باسم: «أخرى نقدية» بقائمة منسدلة — كل بند حسب حسابه بأودو عشان نفهم شو هو
  // 27/11 باسم: توزيع المصاريف (62/63) على الفروع من نص القيد — للقائمة المنسدلة تحت كل بند (شهر 11 وطالع)
  const brBag={}; const brLbl=t=>{t=String(t||'');if(/ناعور/.test(t))return 'ناعور';if(/صافوط/.test(t))return 'صافوط';if(/جمرك/.test(t))return 'الجمرك';if(/دابوق/.test(t))return 'دابوق';if(/مستودع/.test(t))return 'المستودع';return 'بدون تحديد فرع';};
  const addBr=(n,b,m,v)=>{if(m<0)return;const o=(brBag[n]=brBag[n]||{});(o[b]=o[b]||Array(12).fill(0))[m]+=v;};
  // 27/11 باسم: قائمة منسدلة ثانية (لفل واحد) — قيود الشهر الحي لكل بند وحدة وحدة
  const entBag={}; const addEnt=(n,m,l,v)=>{if(m<0||m!==detMonth||NOENT.has(n))return;const a=(entBag[n]=entBag[n]||[]);if(a.length>=200)return;const lb=entLbl(l,sesOf[Array.isArray(l.move_id)?l.move_id[0]:0]);a.push([String(l.date||'').slice(0,10),Array.isArray(l.move_id)?String(l.move_id[1]):'',lb,rr(v)]);};
  const othBag={}; const othLbl=l=>{const a=Array.isArray(l.account_id)?String(l.account_id[1]).replace(/^\d+\s*/,''):'غير محدد';const p=pn_(l.partner_id);return p?a+' · '+p:a;};
  const realNet=Array(12).fill(0);
  for(const m in byMove){if(washIds.has(m)||SKIP_MOVES.has(+m))continue;const ls=byMove[m];let co=0,ci=0,mm=-1;
    for(const l of ls){if(ac_(l.account_id)===accCode){co+=l.credit||0;ci+=l.debit||0;if(mm<0)mm=mo_(l.date);}}
    const oth=ls.filter(l=>ac_(l.account_id)!==accCode);
    /* 27/11 باسم: مرتجعات الموردين (قبض على 210101) ما بتدخل الكاش فلو بتاتاً */
    if(ci>0.001&&co<0.001&&oth.length&&oth.every(l=>ac_(l.account_id)==='210101'))continue;
    if(mm>=0)realNet[mm]+=ci-co;
    const ct=oth.reduce((s,l)=>s+(l.credit||0),0);
    if(co>0.001){
      const _sm=ls.filter(x=>ac_(x.account_id)===accCode).map(x=>x.name||'').join(' ');
      const _mo=l=>((l.name||'')+' '+_sm);
      const outl=oth.filter(l=>l.debit>0&&catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))!=='SKIP');
      const dir=outl.filter(l=>DIRECT.has(catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))));
      const reg=outl.filter(l=>!DIRECT.has(catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l))));
      let dsum=0;
      for(const l of dir){const nm=catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l));add(OUT,nm,mm,l.debit);addEnt(nm,mm,l,l.debit);dsum+=l.debit;if(nm==='أخرى نقدية')add(othBag,othLbl(l),mm,l.debit);if(/^6[23]/.test(ac_(l.account_id)))addBr(nm,brLbl(_mo(l)),mm,l.debit);if(detCat&&nm===detCat&&mm===detMonth){const _pp=pn_(l.partner_id)||'غير محدد';detBag[_pp]=(detBag[_pp]||0)+l.debit;}}
      const regdt=reg.reduce((s,l)=>s+l.debit,0),corest=co-dsum;
      if(corest>0.001&&regdt>0.001)for(const l of reg){const nm=catOut(tag,ac_(l.account_id),pn_(l.partner_id),_mo(l));const _av=corest*(l.debit/regdt);add(OUT,nm,mm,_av);addEnt(nm,mm,l,_av);if(nm==='أخرى نقدية')add(othBag,othLbl(l),mm,_av);if(/^6[23]/.test(ac_(l.account_id)))addBr(nm,brLbl(_mo(l)),mm,_av);if(detCat&&nm===detCat&&mm===detMonth){const _pp=pn_(l.partner_id)||'غير محدد';detBag[_pp]=(detBag[_pp]||0)+_av;}}
    }
    // 27/11 باسم: رجوع كاش من فروقات الصندوق (تصحيح عجز) بيقلّل سطر «فروقات الصندوق» بدل ما ينحسب متحصّل
    if(ci>0.001&&ct>0.001)for(const l of oth){if(!(l.credit>0))continue;const _c=ac_(l.account_id);const _v=ci*(l.credit/ct);if(_c==='640004'||_c==='640005'){add(OUT,'فروقات الصندوق',mm,-_v);addEnt('فروقات الصندوق',mm,l,-_v);continue;}if(_c==='210101')continue; /* 27/11 باسم: المرتجعات مش دخل — بتنخصم من الموردين */const nm=catIn(tag,_c);add(IN,nm,mm,_v);addEnt(nm,mm,l,_v);}
  }
  /* 27/11 باسم: تصحيح «كاش ⇄ فيزا» (كاش الصندوق → حساب الفيزا) = مبيعة انسجلت كاش وهي فيزا — بتنخصم من «مبيعات كاش» لأنها بتنحسب بمبيعات البطاقة، وإلا بتنحسب دخل مرتين */
  if(tag==='box'&&OUT['تحويل لفيزا']){for(let m=0;m<12;m++){const v=OUT['تحويل لفيزا'][m];if(v)add(IN,'مبيعات كاش',m,-v);}delete OUT['تحويل لفيزا'];}
  const R=o=>{const x={};for(const k in o)x[k]=o[k].map(rr);return x;};
  const resid=Array(12).fill(0);
  for(let m=0;m<12;m++){let s=0;for(const n in IN)s+=IN[n][m];for(const n in OUT)s-=OUT[n][m];resid[m]=rr(realNet[m]-s);}
  return {IN:R(IN),OUT:R(OUT),realNet:realNet.map(rr),resid,det:detBag,oth:R(othBag),ent:entBag,br:Object.fromEntries(Object.entries(brBag).map(([k,v])=>[k,R(v)]))};
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
// جمع مصفوفات 12 شهر (أخرى نقدية من الصندوق + البنك)
const _madd=(a,b)=>{const o={};for(const s of [a||{},b||{}])for(const k in s){o[k]=o[k]||Array(12).fill(0);s[k].forEach((v,i)=>{o[k][i]=rr(o[k][i]+(v||0));});}return o;};
// توزيع الفروع: {بند: {فرع: [12]}}
const _mbr=(a,b)=>{const o={};for(const s of [a||{},b||{}])for(const c in s)o[c]=_madd(o[c],s[c]);return o;};
const _mbrL=(p,f,li)=>{const o={};const ks=new Set([...Object.keys(p||{}),...Object.keys(f||{})]);for(const c of ks){const x=_mlive((p||{})[c],(f||{})[c],li);if(Object.keys(x).length)o[c]=x;}return o;};
// الوضع الخفيف: الشهور السابقة من المجمّد، والشهر الحالي طازج
const _mlive=(prev,fresh,li)=>{const o={};const ks=new Set([...Object.keys(prev||{}),...Object.keys(fresh||{})]);for(const k of ks){const a=((prev||{})[k]||Array(12).fill(0)).slice();a[li]=((fresh||{})[k]&&fresh[k][li])||0;if(a.some(v=>Math.abs(v)>0.0005))o[k]=a.map(rr);}return o;};
export async function computeMonthly(rpc,uid,DB,KEY,opts){
  opts=opts||{};
  if(opts.light && opts.prev && opts.prev.box && opts.prev.bank && !opts.prev.error && typeof opts.liveIdx==='number'){
    const from=opts.liveStart||'2026-01-01';
    const boxF=await flowsFor(rpc,uid,DB,KEY,'110101','box',from,'الرواتب والأجور',opts.liveIdx);
    const bankF=await flowsFor(rpc,uid,DB,KEY,'110102','bank',from,'الرواتب والأجور',opts.liveIdx);
    return {box:mergeMonth(opts.prev.box,boxF,opts.liveIdx), bank:mergeMonth(opts.prev.bank,bankF,opts.liveIdx), det:_mdet(boxF.det,bankF.det), oth:_mlive(opts.prev.oth,_madd(boxF.oth,bankF.oth),opts.liveIdx), br:_mbrL(opts.prev.br,_mbr(boxF.br,bankF.br),opts.liveIdx), ent:_ment(boxF.ent,bankF.ent), light:true};
  }
  const _li=(typeof opts.liveIdx==='number')?opts.liveIdx:-1;
  const box=await flowsFor(rpc,uid,DB,KEY,'110101','box',undefined,'الرواتب والأجور',_li);
  const bank=await flowsFor(rpc,uid,DB,KEY,'110102','bank',undefined,'الرواتب والأجور',_li);
  return {box,bank,det:_mdet(box.det,bank.det),oth:_madd(box.oth,bank.oth),br:_mbr(box.br,bank.br),ent:_ment(box.ent,bank.ent)};
}
