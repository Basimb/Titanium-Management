import test from 'node:test';
import assert from 'node:assert/strict';
import { priorityTaskQuery } from '../lib/secretary-priority-query.ts';
const owner={id:'basem',name:'باسم',role:'admin'};
const catalog={actor:owner,users:[{id:'basem',name:'باسم',active:1},{id:'k',name:'خالد',active:1},{id:'a',name:'أيمن',active:1},{id:'off',name:'معطل',active:0}]};
const parse=(text,extra={})=>priorityTaskQuery(text,{...catalog,...extra});

test('explicit color lists and short follow-ups are read queries without history',()=>{
  for(const [text,priority] of [['اعطيني المهام الحمراء','red'],['وريني المهام الصفراء','yellow'],['بدي المهام الخضراء','green'],['المهام الحمراء','red'],['والصفراء؟','yellow'],['والخضرا؟','green'],['وريني المهام 🔴','red'],['مهام 🟡','yellow'],['اعرض لي المهام 🟩','green'],['لو سمحت وريني المهام الحمرا','red']]) assert.deepEqual(parse(text),{kind:'query',priority},text);
});
test('site priority names map to actual red maximum, yellow medium, green normal',()=>{
  for(const [word,priority] of [['قصوى','red'],['عالية','red'],['متوسطة','yellow'],['عادية','green'],['منخفضة','green']]) assert.deepEqual(parse('المهام ذات الأولوية '+word),{kind:'query',priority});
});
test('color never implies completion or lateness; explicit status is separate',()=>{
  assert.deepEqual(parse('المهام الخضراء'),{kind:'query',priority:'green'});
  for(const [status,value] of [['المفتوحة','open'],['قيد التنفيذ','progress'],['بانتظار اعتماد باسم','approval'],['المعتمدة','completed'],['المتأخرة','overdue']]) assert.deepEqual(parse('المهام الحمراء '+status),{kind:'query',priority:'red',status:value});
});
test('exact authorized owner and state qualifiers compose without dropping filters',()=>{
  assert.deepEqual(parse('وريني المهام الحمراء لخالد قيد التنفيذ'),{kind:'query',priority:'red',ownerId:'k',status:'progress'});
  assert.deepEqual(parse('المهام الصفراء لأيمن'),{kind:'query',priority:'yellow',ownerId:'a'});
  // A project qualifier is not a filter anymore -- it is simply unknown, and an
  // unknown qualifier is asked about rather than silently dropped.
  assert.equal(parse('المهام الصفراء لأيمن في مشروع تجريبي').kind,'clarify');
  assert.deepEqual(parse('مهامي الخضراء'),{kind:'query',priority:'green',ownerId:'basem'});
  assert.deepEqual(parse('المهام الخضراء الخاصة بي'),{kind:'query',priority:'green',ownerId:'basem'});
});
test('pagination is explicit, zero based and supports Arabic digits with complete filters',()=>{
  assert.deepEqual(parse('المهام الحمراء من 11'),{kind:'query',priority:'red',offset:10});
  assert.deepEqual(parse('المهام الصفراء لخالد المتأخرة من ٢١'),{kind:'query',priority:'yellow',ownerId:'k',status:'overdue',offset:20});
  assert.equal(parse('المهام الخضراء من ۱').offset,0);
  for(const suffix of ['0','10001','999999999999999999']) assert.equal(parse('المهام الحمراء من '+suffix).kind,'clarify');
});
test('multiple colors, conflicting scopes/status and unknown extra qualifiers clarify',()=>{
  for(const text of ['المهام الحمراء والصفراء','المهام 🔴 🟢','المهام الحمراء المعتمدة قيد التنفيذ','المهام الحمراء لخالد لأيمن',
    'المهام الحمراء بكرا','المهام الحمراء إلا مهمة المشتريات','المهام الحمراء بنسبة خمسين','المهام الحمراء ضمن مشروع مجهول','المهام الحمراء لموظف مجهول','المهام الحمراء لمُعطّل']) assert.equal(parse(text).kind,'clarify',text);
  assert.deepEqual(parse('المهام الحمراء 🔴'),{kind:'query',priority:'red'});
});
test('negated, hypothetical, quoted, drafting and read-plus-change instructions are not hijacked',()=>{
  for(const text of ['لا تعطيني المهام الحمراء','ما بدي المهام الخضراء','لو وريني المهام الصفراء','كيف أغير المهام الحمراء؟','غير المهام الحمراء','خلي المهام حمراء','«المهام الحمراء»',
    'اكتب رسالة تقول وريني المهام الحمراء','لو سمحت اكتبلي المهام الحمراء','وريني المهام الحمراء وغير أولويتها','المهام الحمراء لا الصفراء','وريني المهام الحمراء ثم احذفها','وريني المهام الحمراء\nاحذفها']) assert.equal(parse(text),null,text);
});
test('ambiguous names require a literal catalog ID and no inactive user is resolved',()=>{
  assert.equal(parse('المهام الحمراء لخالد',{users:[{id:'x',name:'خالد'},{id:'y',name:'خالد'}]}).kind,'clarify');
  assert.deepEqual(parse('المهام الحمراء لـ x',{users:[{id:'x',name:'خالد'},{id:'y',name:'خالد'}]}),{kind:'query',priority:'red',ownerId:'x'});
  assert.equal(parse('المهام الحمراء لمعطل').kind,'clarify');
});
test('member can request own list but cannot widen it to another person or impersonate admin',()=>{
  const actor={id:'k',name:'خالد',role:'member'};
  assert.deepEqual(parse('مهامي الحمراء',{actor}),{kind:'query',priority:'red',ownerId:'k'});
  assert.deepEqual(parse('المهام الحمراء لخالد',{actor}),{kind:'query',priority:'red',ownerId:'k'});
  assert.equal(parse('المهام الحمراء لأيمن',{actor}).kind,'clarify');
  assert.equal(parse('المهام الحمراء لأيمن',{actor:{...actor,role:'admin'}}).kind,'clarify');
});
test('ordinary conversation, missing colors and bare confirmation remain outside parser',()=>{
  for(const text of ['مرحبا','شو مهامي؟','المهام','نعم','موافق T123ABC','بدي أخضر','الأخضر جميل','شو معنى المهام الحمراء؟','والتفاصيل؟']) assert.equal(parse(text),null,text);
});
