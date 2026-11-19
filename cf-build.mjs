// cf-build.mjs (v3) — يسحب الكاش فلو الحي من أودو ويكتب JSON للوحة. كرون كل 8 ساعات. Node 16 (https بدل fetch).
// الجديد: الشهر الحالي (حسب تاريخ عمّان) يتقسم عمودين — «فعلي» (المنصرف/المقيّد هذا الشهر) و«باقي» (المستحق غير المصروف). الأعمدة 25.
import fs from 'node:fs';
import https from 'node:https';
import { URL } from 'node:url';
import { computeMonthly, SKIP_MOVES } from './cf-flows.mjs';
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '2';

const CFG_PATH = process.env.CFG || '/home/titani24/.titanium-team-chat/config.json';
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const BASE = (CFG.ODOO_URL || '').replace(/\/+$/, '');
const DB = CFG.ODOO_DB, USER = CFG.ODOO_USERNAME, KEY = CFG.ODOO_API_KEY;
const OUT = '/home/titani24/public_html/cf-live-7h3k9x2.json';

const OPENING = { '110101': 698.60, '110102': 2000.25, '110103': 0, '110104': 2294.00 };
const NAMES = { '110101': 'الصندوق', '110102': 'البنك العربي', '110103': 'بنك صفوة', '110104': 'فيزا تحت التحصيل' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const AR_MONTH = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

// تاريخ عمّان
const AMMAN = new Date(Date.now() + 3*3600000);
const LY = AMMAN.getUTCFullYear(), LM = AMMAN.getUTCMonth()+1; // 1-based
let LIVE_BASE = (LY-2026)*12 + (LM-1); if(LIVE_BASE<0)LIVE_BASE=0; if(LIVE_BASE>23)LIVE_BASE=23;
const p2 = n => String(n).padStart(2,'0');
const LIVE_START = `${LY}-${p2(LM)}-01`;
const TODAY = `${LY}-${p2(LM)}-${p2(AMMAN.getUTCDate())}`;
const prevEnd = new Date(Date.UTC(LY, LM-1, 1) - 86400000); // آخر يوم بالشهر السابق
const PREV_END = `${prevEnd.getUTCFullYear()}-${p2(prevEnd.getUTCMonth()+1)}-${p2(prevEnd.getUTCDate())}`;
const LIVE_END = (() => { const e = new Date(Date.UTC(LY, LM, 1) - 86400000); return `${e.getUTCFullYear()}-${p2(e.getUTCMonth()+1)}-${p2(e.getUTCDate())}`; })();
const NC = 25;

function nowISO(){ const z=AMMAN; return `${z.getUTCFullYear()}-${p2(z.getUTCMonth()+1)}-${p2(z.getUTCDate())}T${p2(z.getUTCHours())}:${p2(z.getUTCMinutes())}:${p2(z.getUTCSeconds())}+03:00`; }
const r3 = v => Math.round(v*1000)/1000;

function rpc(service, method, args){
  const body = JSON.stringify({ jsonrpc:'2.0', method:'call', params:{ service, method, args } });
  const u = new URL(BASE + '/jsonrpc');
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:u.hostname, port:u.port||443, path:(u.pathname||'/jsonrpc'), method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } }, res => {
      let data=''; res.setEncoding('utf8'); res.on('data', c=>data+=c);
      res.on('end', () => { try { const j=JSON.parse(data);
        if (j.error) reject(new Error((j.error.data&&j.error.data.message)||j.error.message||JSON.stringify(j.error)));
        else resolve(j.result);
      } catch(e){ reject(new Error('رد غير صالح من أودو: '+String(e.message||e))); } });
    });
    req.on('error', reject);
    req.setTimeout(60000, ()=>req.destroy(new Error('انتهت مهلة الاتصال بأودو')));
    req.write(body); req.end();
  });
}
const writeOut = obj => fs.writeFileSync(OUT, JSON.stringify(obj, null, 1), 'utf8');

// شهر label -> base24 (0..23) ثم -1 لغير ذلك
function monthBase(label){ const p=String(label||'').split(' '); const mi=MONTHS.indexOf(p[0]); const y=+p[p.length-1];
  if(mi<0||!y) return -1; const b=(y-2026)*12+mi; return (b>=0&&b<24)?b:-1; }
// base24 -> عمود في مخطط 25
function col25(base24, kind){ if(kind==='actual') return LIVE_BASE; if(kind==='remain') return LIVE_BASE+1;
  if(base24 < LIVE_BASE) return base24; return base24+1; }
const pname = pid => Array.isArray(pid)?String(pid[1]):'';
// due_date 'YYYY-MM-DD' -> base24 month index
function dueBase(d){ const m=String(d||'').match(/^(\d{4})-(\d{2})/); if(!m) return -99; return (+m[1]-2026)*12+(+m[2]-1); }

function classify(n){
  if(/الضمان الاجتماعي|الضمان الإجتماعي|للضمان/.test(n)) return ['أخرى (شيكات)','الضمان (شيكات)'];
  if(/مؤسسة صيدلية تيتانيوم|مؤسسة تيتانيوم/.test(n)) return ['أخرى (شيكات)','تقسيط ضريبة المبيعات'];
  if(/موسى عبد المهدي مطيرة|أبو طارق|ابو طارق/.test(n)) return ['إيجارات (شيكات)','إيجار ناعور (موسى)'];
  if(/سميح عوده|سميح عودة/.test(n)) return ['إيجارات (شيكات)','إيجار صافوط (سميح)'];
  if(/ليمار|الشوابكه|الشوابكة/.test(n)) return ['إيجارات (شيكات)','إيجار دابوق (ليمار)'];
  if(/عيادات تيتانيوم/.test(n)) return ['أخرى (شيكات)','عيادات تيتانيوم (شيكات)'];
  if(/جامعة البتراء/.test(n)) return ['مسحوبات باسم (شيكات)','لمى — جامعة البتراء'];
  if(/جامعة العلوم التطبيقية/.test(n)) return ['مسحوبات باسم (شيكات)','جامعة العلوم التطبيقية'];
  if(/الفيصل/.test(n) && /محاما|قانون/.test(n)) return ['أخرى (شيكات)','أتعاب محاماة (الفيصل)'];
  if(/شادي/.test(n)) return ['أخرى (شيكات)','شيكات شادي الربضي'];
  if(/رند|عازر عواد|عواد/.test(n)) return ['أخرى (شيكات)','شراء صيدلية دابوق (رند)'];
  return ['موردون أدوية (شيكات)', n];
}
const CHQ_SECTIONS=['موردون أدوية (شيكات)','موردون آخرون (شيكات)','إيجارات (شيكات)','مسحوبات باسم (شيكات)','أخرى (شيكات)'];

try {
  const uid = await rpc('common','authenticate',[DB, USER, KEY, {}]);
  if (!uid) throw new Error('فشل تسجيل الدخول لأودو — تأكد من المفتاح المخزّن.');

  // ===== 1) الأرصدة والحركة الشهرية للحسابات النقدية =====
  const domain = [['account_id.code','in',['110101','110102','110103','110104']],['parent_state','=','posted'],['date','>=','2026-01-01'],['date','<=','2026-12-31']];
  const rows = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',[domain, ['balance'], ['account_id','date:month']], { lazy:false }]);
  const perAcc = { '110101':0,'110102':0,'110103':0,'110104':0 };
  const realmov = Array(12).fill(0);
  for (const row of rows) {
    const code = (String(pname(row.account_id)).match(/^\d+/) || [])[0];
    if (!(code in OPENING)) continue;
    const bal = row.balance || 0; perAcc[code] += bal;
    const mi = MONTHS.indexOf(String(row['date:month'] || '').split(' ')[0]);
    if (mi >= 0) realmov[mi] += bal;
  }
  const current = {}; let total = 0;
  for (const code of Object.keys(OPENING)) { const v = OPENING[code] + perAcc[code]; current[NAMES[code]] = r3(v); total += v; }
  current['الإجمالي'] = r3(total);
  const openSum = OPENING['110101']+OPENING['110102']+OPENING['110103']+OPENING['110104'];
  const real_open_live = r3(openSum + realmov.slice(0, LIVE_BASE).reduce((a,b)=>a+b,0));

  // ===== 2) تفصيل الشيكات: ماضٍ (صرف) + فعلي الشهر (صرف هذا الشهر) + باقي (مستحق) + مستقبل =====
  // الماضي: المصروف فعلاً (مدين على 210102) حسب تاريخ القيد حتى آخر الشهر السابق
  const clr = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','210102'],['parent_state','=','posted'],['debit','>',0],['partner_id','!=',false],['date','>=','2026-01-01'],['date','<=',PREV_END]],
     ['debit'], ['partner_id','date:month']], { lazy:false }]);
  // فعلي الشهر الحي: المصروف فعلاً خلال الشهر الحالي (يشمل شيكات مكتوبة لشهر سابق وانصرفت الآن)
  const liveClr = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','210102'],['parent_state','=','posted'],['debit','>',0],['partner_id','!=',false],['date','>=',LIVE_START],['date','<=',TODAY]],
     ['debit'], ['partner_id']], { lazy:false }]);
  // المستقبل والباقي: الشيكات المكتوبة وغير المصروفة بعد — من سجل الشيكات (PDC) حسب الحالة (مودعة/مسجّلة)، موثوق مش full_reconcile
  const pend = await rpc('object','execute_kw',[DB, uid, KEY, 'pdc.wizard','search_read',
    [[['payment_type','=','send_money'],['state','in',['registered','deposited']]], ['partner_id','payment_amount','due_date']], { limit: 5000 }]);
  // شيكات قديمة (استحقاق قبل الشهر الحي) مكتوبة وغير مصروفة بعد → مشاكل السحب
  const over = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','210102'],['parent_state','=','posted'],['credit','>',0],['full_reconcile_id','=',false],['partner_id','!=',false],['date_maturity','>=','2026-01-01'],['date_maturity','<=',PREV_END]],
     ['credit'], ['partner_id','date_maturity:month']], { lazy:false }]);

  // دخل الشهر الفعلي (كاش + فيزا)
  const liRows = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','in',['110101','110104']],['parent_state','=','posted'],['debit','>',0],['date','>=',LIVE_START],['date','<=',TODAY]],
     ['debit'], ['account_id']], { lazy:false }]);
  let cashSales=0, cardSales=0;
  for(const r of liRows){ const code=(String(pname(r.account_id)).match(/^\d+/)||[])[0]; if(code==='110101')cashSales+=r.debit||0; else if(code==='110104')cardSales+=r.debit||0; }
  // تحصيل تأمين + متحصلات أخرى (مدين على البنك حسب الطرف) + مصاريف نقدية غير مسمّاة
  const bankIn = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','110102'],['parent_state','=','posted'],['debit','>',0],['partner_id','!=',false],['date','>=',LIVE_START],['date','<=',TODAY]],
     ['debit'], ['partner_id']], { lazy:false }]);
  const INS=/NAT HEALTH|Mednet|ميديكسا|المجموعة العربية|نيوتن|نقابة|الشرق العربي|الأولى للتأمين|غلوب|الإسلامية|Medservice|اومني|أومني|تأمين/i;
  let insurIn=0, othIn=0;
  for(const r of bankIn){ const n=pname(r.partner_id); if(!n) continue; if(INS.test(n)) insurIn+=r.debit||0; else othIn+=r.debit||0; }
  // موردون أدوية (كاش) + أخرى كاش (فروقات صندوق) — يومية نقدية فقط (الإيداعات البنكية تحويل داخلي تُستثنى)
  const cashOut = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','110101'],['parent_state','=','posted'],['credit','>',0],['journal_id.type','=','cash'],['move_id','not in',[...SKIP_MOVES]],['date','>=',LIVE_START],['date','<=',TODAY]],
     ['credit'], ['partner_id']], { lazy:false }]);
  let supCashDrug=0, cashOther=0;
  for(const r of cashOut){ if(r.partner_id) supCashDrug+=r.credit||0; else cashOther+=r.credit||0; }
  // رواتب/ذمم موظفين مدفوعة من البنك (110205 مدين ضمن قيد يدائن البنك) + باقي مصاريف بنكية (عمولات)
  const bankCrLines = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','search_read',
    [[['account_id.code','=','110102'],['parent_state','=','posted'],['credit','>',0],['date','>=',LIVE_START],['date','<=',TODAY]], ['move_id','credit']]]);
  let bankCredTot=0; const bankMoveIds=[];
  for(const r of bankCrLines){ bankCredTot+=r.credit||0; if(r.move_id) bankMoveIds.push(r.move_id[0]); }
  let salByTransfer=0, shadiBank=0, staffTotal=0;
  if(bankMoveIds.length){ const staffPaid = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','110205'],['parent_state','=','posted'],['debit','>',0],['move_id','in',bankMoveIds]], ['debit'], ['partner_id']], { lazy:false }]);
    for(const g of staffPaid){ const amt=g.debit||0; staffTotal+=amt; salByTransfer+=amt; } }
  let chqLiveSum=0; for(const row of liveClr) chqLiveSum += row.debit||0;
  const bankOther = Math.max(0, bankCredTot - chqLiveSum - staffTotal);
  const bucket = {}; // key -> {section,name,arr[25]}
  const ensure = (sec,disp)=>{ const k=sec+'||'+disp; if(!bucket[k]) bucket[k]={section:sec,name:disp,arr:Array(NC).fill(0)}; return bucket[k]; };
  for(const row of clr){ const b24=monthBase(row['date:month']); if(b24<0||b24>=LIVE_BASE) continue; const [sec,disp]=classify(pname(row.partner_id)); ensure(sec,disp).arr[col25(b24,'past')]+=row.debit||0; }
  for(const row of liveClr){ const [sec,disp]=classify(pname(row.partner_id)); ensure(sec,disp).arr[col25(0,'actual')]+=row.debit||0; }
  for(const row of pend){ const n=pname(row.partner_id); if(!n) continue; const amt=row.payment_amount||0; if(amt<0.001) continue;
    const b24=dueBase(row.due_date); let col;
    if(b24<=LIVE_BASE) col=col25(0,'remain'); else if(b24<=23) col=col25(b24,'future'); else continue;
    const [sec,disp]=classify(n); ensure(sec,disp).arr[col]+=amt; }
  // شادي: راتب مدفوع بنكياً — المحرّك يصنّفه ضمن الرواتب، فلا يُكرَّر كشيك (كان يسبّب ازدواج 1140)

  const details={}; for(const s of CHQ_SECTIONS) details[s]=[];
  for(const k of Object.keys(bucket)){ const b=bucket[k]; const arr=b.arr.map(r3);
    if(arr.reduce((a,c)=>a+Math.abs(c),0)<0.001) continue; details[b.section].push([b.name,arr]); }
  for(const s of CHQ_SECTIONS) details[s].sort((a,b)=>b[1].reduce((x,y)=>x+y,0)-a[1].reduce((x,y)=>x+y,0));
  // تفصيل موردون أدوية (كاش) — الشهر الحالي فقط (حسب المورّد، من حركات الصندوق النقدية)
  const cashDrugDet=[];
  for(const r of cashOut){ if(!r.partner_id) continue; const amt=r.credit||0; if(amt<0.001) continue;
    const a=Array(NC).fill(0); a[col25(0,'actual')]=r3(amt); cashDrugDet.push([pname(r.partner_id),a]); }
  cashDrugDet.sort((x,y)=>y[1].reduce((p,q)=>p+q,0)-x[1].reduce((p,q)=>p+q,0));
  details['موردون أدوية (كاش)']=cashDrugDet;
  // تفصيل تحصيل التأمين حسب الشركة — الشهر الحالي (من إيداعات البنك حسب الطرف)
  // 19/11/2026 باسم: تفصيل التأمين من نفس معيار المجموع (الحساب المقابل 110202/110204 بقيود البنك) مش من اسم الطرف — حتى ما يظهر نفس المبلغ بتفصيلين
  const insDet=[];
  { const insRows = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
      [[['account_id.code','in',['110202','110204']],['parent_state','=','posted'],['credit','>',0],['date','>=',LIVE_START],['date','<=',TODAY],['move_id.line_ids.account_id.code','=','110102']], ['credit'], ['partner_id']], { lazy:false }]);
    for(const g of insRows){ const amt=g.credit||0; if(amt<0.001) continue; const a=Array(NC).fill(0); a[col25(0,'actual')]=r3(amt); insDet.push([pname(g.partner_id)||'غير محدد',a]); } }
  const cbIn = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','search_read',
    [[['account_id.code','in',['110101','110102']],['parent_state','=','posted'],['debit','>',0],['date','>=',LIVE_START],['date','<=',TODAY]], ['move_id']]]);
  const cbIds=[...new Set(cbIn.map(r=>r.move_id&&r.move_id[0]).filter(Boolean))].filter(id=>!SKIP_MOVES.has(id));
  const arDet=[];
  if(cbIds.length){ const arRows = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','110201'],['parent_state','=','posted'],['credit','>',0],['move_id','in',cbIds]], ['credit'], ['partner_id']], { lazy:false }]);
    for(const g of arRows){ const amt=g.credit||0; if(amt<0.001) continue; const a=Array(NC).fill(0); a[col25(0,'actual')]=r3(amt); arDet.push([pname(g.partner_id)||'\u063a\u064a\u0631 \u0645\u062d\u062f\u062f',a]); } }
  arDet.sort((x,y)=>y[1][col25(0,'actual')]-x[1][col25(0,'actual')]);
  const cbOut = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','search_read',
    [[['account_id.code','in',['110101','110102']],['parent_state','=','posted'],['credit','>',0],['date','>=',LIVE_START],['date','<=',TODAY]], ['move_id']]]);
  const cbOutIds=[...new Set(cbOut.map(r=>r.move_id&&r.move_id[0]).filter(Boolean))];
  const comDet=[];
  if(cbOutIds.length){ const comRows = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','in',['110205','610004']],['parent_state','=','posted'],['debit','>',0],['move_id','in',cbOutIds],'|',['account_id.code','=','610004'],['name','ilike','\u0639\u0645\u0648\u0644']], ['debit'], ['partner_id']], { lazy:false }]);
    for(const g of comRows){ const amt=g.debit||0; if(amt<0.001) continue; const a=Array(NC).fill(0); a[col25(0,'actual')]=r3(amt); comDet.push([pname(g.partner_id)||'\u063a\u064a\u0631 \u0645\u062d\u062f\u062f',a]); } }
  const comAcc = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=','110205'],['parent_state','=','posted'],['credit','>',0],['date','>=',PREV_END.slice(0,8)+'01'],['date','<=',PREV_END],['move_id.line_ids.account_id.code','=','610004']], ['credit'], ['partner_id']], { lazy:false }]);
  for(const g of comAcc){ const nm=pname(g.partner_id)||'\u063a\u064a\u0631 \u0645\u062d\u062f\u062f'; const acc=g.credit||0; if(acc<0.001) continue;
    let row=comDet.find(x=>x[0]===nm); if(!row){ row=[nm,Array(NC).fill(0)]; comDet.push(row); }
    row[1][col25(0,'remain')]=r3(Math.max(0, acc-(row[1][col25(0,'actual')]||0))); }
  comDet.sort((x,y)=>x[0].localeCompare(y[0],'ar'));
  details['\u0639\u0645\u0648\u0644\u0627\u062a \u0628\u064a\u0639 \u0644\u0644\u0639\u0627\u0645\u0644\u064a\u0646']=comDet;
  details['\u062a\u062d\u0635\u064a\u0644 \u0630\u0645\u0645 \u0639\u0645\u0644\u0627\u0621']=arDet;
  details['تحصيل تأمين']=insDet;

  // 19/11/2026 باسم: ذمم الموظفين الفعلية (110205) لكل موظف، مقسومة عمولة/راتب — الباقي للموظف على الشركة
  // 19/11/2026 باسم: البطاقة الفعلية غير المودعة = مبيعات بطاقات الورديات اللي سكّرت بعد آخر قيد تحصيل بنكي على حساب الفيزا (110104)
  let card_real=null; try{
    const lb = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','search_read',
      [[['account_id.code','=','110104'],['parent_state','=','posted'],['credit','>',0],['move_id.name','=like','BNK01/%']], ['id','date']], { order:'id desc', limit:1 }]);
    const lastId = lb.length ? lb[0].id : 0;
    const cs = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
      [[['account_id.code','=','110104'],['parent_state','=','posted'],['debit','>',0],['id','>',lastId],['move_id.name','=like','PBNK1/%']], ['debit'], []], { lazy:false }]);
    card_real = { amount: r3((cs[0]&&cs[0].debit)||0), n: (cs[0]&&cs[0].__count)||0, last_bank_date: lb.length?lb[0].date:null };
  }catch(_){ card_real=null; }
  let staff_due=[]; try{
    const sdAll = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
      [[['account_id.code','=','110205'],['parent_state','=','posted'],['partner_id','!=',false]], ['balance'], ['partner_id']], { lazy:false }]);
    const sdCom = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
      [[['account_id.code','=','110205'],['parent_state','=','posted'],['partner_id','!=',false],['date','>=','2026-01-01'],'|',['name','ilike','عمول'],['move_id.line_ids.account_id.code','=','610004']], ['debit','credit'], ['partner_id']], { lazy:false }]);
    const comOpen={}; for(const g of sdCom){ if(g.partner_id) comOpen[g.partner_id[0]] = (g.credit||0)-(g.debit||0); }
    for(const g of sdAll){ if(!g.partner_id) continue; const due=-(g.balance||0); if(due<0.001) continue;
      const comm=Math.min(due, Math.max(0, comOpen[g.partner_id[0]]||0));
      staff_due.push({ partner:pname(g.partner_id), due:r3(due), comm:r3(comm), sal:r3(due-comm) }); }
    staff_due.sort((a,b)=>b.due-a.due);
  }catch(_){ staff_due=null; }
  let accrued=[]; try{ const ac = await rpc('object','execute_kw',[DB, uid, KEY, 'account.move.line','read_group',
    [[['account_id.code','=like','6%'],['parent_state','=','posted'],['date','>=','2026-01-01'],['date','<=','2026-12-31']], ['balance'], ['account_id','date:month']], { lazy:false }]);
    const am={}; for(const g of ac){ const nm=pname(g.account_id); const mi=MONTHS.indexOf(String(g['date:month']||'').split(' ')[0]); if(!nm||mi<0) continue; if(!am[nm]) am[nm]=Array(12).fill(0); am[nm][mi]+=g.balance||0; }
    accrued=Object.keys(am).sort().map(k=>[k,am[k].map(r3)]); }catch(_){ accrued=[]; }
  const cheque_issues=[];
  for(const row of over){ const amt=r3(row.credit||0); if(amt<0.001) continue;
    cheque_issues.push({ partner:pname(row.partner_id), due:String(row['date_maturity:month']||''), amount:amt }); }
  cheque_issues.sort((a,b)=>b.amount-a.amount);
  let monthly=null; try{ let prevMonthly=null; if(process.env.CF_LIGHT==="1"){ try{ prevMonthly=JSON.parse(fs.readFileSync(OUT,"utf8")).monthly; }catch(_){} } const mopts=(process.env.CF_LIGHT==="1"&&prevMonthly&&!prevMonthly.error)?{light:true,prev:prevMonthly,liveIdx:LIVE_BASE,liveStart:LIVE_START}:{liveIdx:LIVE_BASE}; monthly=await computeMonthly(rpc,uid,DB,KEY,mopts); }catch(e){ monthly={error:String(e&&e.message||e)}; }

  if(monthly&&monthly.det&&Object.keys(monthly.det).length){ const sd=[]; for(const nm in monthly.det){ const a=Array(NC).fill(0); a[col25(0,'actual')]=r3(monthly.det[nm]); sd.push([nm,a]); } sd.sort((x,y)=>y[1].reduce((s,v)=>s+v,0)-x[1].reduce((s,v)=>s+v,0)); if(sd.length) details['الرواتب والأجور']=sd; }
  writeOut({ generated_at: nowISO(), source: 'أودو مباشرة',
    live_idx: LIVE_BASE, live_label: `${AR_MONTH[LM-1]} ${LY}`,
    opening: { 'الصندوق':698.6,'البنك العربي':2000.25,'بنك صفوة':0,'فيزا تحت التحصيل':2294.0,'الإجمالي':4992.85 },
    current, realmov: realmov.map(r3),
    real_open_live,
    closing_oct: real_open_live,
    live_income: { 'مبيعات كاش': r3(cashSales), 'تحصيل فيزا': r3(cardSales), 'تحصيل تأمين': r3(insurIn), 'متحصلات أخرى وتسويات': r3(othIn), 'موردون أدوية (كاش)': r3(supCashDrug), 'أخرى (كاش)': r3(cashOther), 'الرواتب والأجور': r3(salByTransfer), 'مصاريف بنكية': r3(bankOther) },
    monthly,
    details, cheque_issues, accrued, staff_due, card_real,
    errors: [], note: 'يُحدَّث آليًا كل 8 ساعات — الشهر الحالي مقسوم فعلي/باقي' });
  const fdone = Object.values(details).reduce((a,c)=>a+c.length,0);
  console.log(`cf-build v3 ok — balance=${current['الإجمالي']} | open_live=${real_open_live} | rows=${fdone} | issues=${cheque_issues.length} | live_idx=${LIVE_BASE}`);
} catch (e) {
  const err = { time: nowISO().replace('T',' ').slice(0,16), msg: String((e && e.message) || e) };
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch {}
  prev.errors = [err, ...(prev.errors || [])].slice(0, 20);
  prev.last_error_at = err.time;
  writeOut(prev);
  console.error('cf-build error — ' + err.msg);
  process.exit(1);
}
