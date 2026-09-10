import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent } from '../lib/secretary-intent.ts';

// Same isolated management fixture as secretary-service.test.mjs.
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('p2','مشروع ثان','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('t','p','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL),
      ('private','p2','مهمة شادي الخاصة','تفاصيل سرية','yellow','progress','شادي','شادي',1,NULL,NULL,NULL,1,1,NULL,NULL);
    -- secretaryTaskCard no longer surfaces task.details at all (Basim: "شيل
    -- المطلوب من القصة") -- the last comment is now the only detail-bearing
    -- text a "details" reply shows, so the sensitive marker this file's
    -- leak tests look for has to live there instead of in task.details.
    INSERT INTO comments VALUES(1,'private','شادي','تفاصيل سرية',1);`);
  migrateSecretary(db);
  const config = { enabled:true, sharedKey:'ab'.repeat(32), contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let count = 0, now = 1788580000000;
  const event = (extra={}) => ({ messageId:`EVENT-${++count}`,senderNumber:'12025550101',groupId:null,text:'شو مهامي؟',receivedAt:now,responseMessageId:`REPLY-${count}`, ...extra });
  const run = (plan=emptySecretaryIntent('summary'),extra={},infer) => handleSecretaryEvent(db,event(extra),config,{ infer:infer || (async()=>plan),now:()=>now });
  return {db,config,event,run,get now(){return now;},tick:n=>{now+=n;}};
}
function command(action,fields={},taskId='t',projectId=null) { const p=emptySecretaryIntent('command');return {...p,action,taskId,projectId,fields:{...p.fields,...fields}}; }
function teamMessage(text='الاجتماع بكرا الساعة 10',recipientIds=['all-team']) { const p=emptySecretaryIntent('message_team');p.fields.body=text;p.recipientIds=recipientIds;return p; }

const owner = { senderNumber:'12025550103' };
const question = 'شو الفرق بين LED و OLED؟';
const previousAnswer = 'الشاشتان تستعملان التقنية نفسها.';
const noInference = async () => { assert.fail('This route must not invoke the model'); };
const noSearch = async () => { assert.fail('This route must not invoke public search'); };
function forbiddenProvider(t, name) {
  const callback=t.mock.fn(name==='infer'?noInference:noSearch);
  // Review deliberately catches provider failures: assert calls outside that catch.
  t.after(()=>assert.equal(callback.mock.callCount(),0,`Unexpected ${name} call`));
  return callback;
}
const noProviders = (t,f) => ({infer:forbiddenProvider(t,'infer'),search:forbiddenProvider(t,'search'),now:()=>f.now});
const businessTables = ['users','projects','tasks','comments','attachments','audit_logs','secretary_pending','secretary_task_intake','secretary_choices','secretary_reminders','secretary_outbox_batches','secretary_outbox_deliveries','secretary_outbox_transport'];
const businessSnapshot = db => Object.fromEntries(businessTables.map(table => [table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('identity names Basim secretary without inference, search, or business changes', async t => {
  const f=fixture(t), before=businessSnapshot(f.db); let inferred=0,searched=0;
  const result=await handleSecretaryEvent(f.db,f.event({text:'مين انت'}),f.config,{
    infer:async()=>{inferred++;return emptySecretaryIntent('chat','Wrong identity');},
    search:async()=>{searched++;return 'Unrequested search';},now:()=>f.now,
  });
  assert.match(result.reply,/سكرتير باسم/);assert.ok(result.reply.length<500);
  assert.equal(inferred,0);assert.equal(searched,0);assert.deepEqual(businessSnapshot(f.db),before);
});

test('review binds prior question and answer, and searches that question rather than criticism or model query', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
  const before=businessSnapshot(f.db);let inputSeen;const searches=[];
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,{
    infer:async input=>{inputSeen=input;return emptySecretaryIntent('search','Different public model query');},
    search:async query=>{searches.push(query);return 'نتيجة بحث موثقة https://example.com/display';},now:()=>f.now,
  });
  assert.deepEqual(inputSeen.review,{previousQuestion:question,previousAnswer});
  assert.equal(inputSeen.text,'جوابك غلط');assert.deepEqual(searches,[question]);
  assert.match(result.reply,/https:\/\/example.com\/display/);assert.deepEqual(businessSnapshot(f.db),before);
});

test('criticism without an eligible earlier question clarifies without inference or search', async t => {
  const f=fixture(t);
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,noProviders(t,f));
  assert.equal(result.status,'clarify');assert.ok(result.reply.trim());
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
});

const prohibitedPlans = {
  command: () => command('comment',{body:'تحديث غير مأذون'}),
  message_team: () => teamMessage('إرسال غير مأذون',['member']),
  remind: now => { const p=emptySecretaryIntent('remind');p.taskId='t';p.fields.remindAt=new Date(now+120000).toISOString();return p; },
  task_draft: () => { const p=emptySecretaryIntent('task_draft');p.intakeMode='start';p.projectId='p';Object.assign(p.fields,{title:'مسودة بديلة غير مأذونة',ownerId:'member',priority:'green',dueDate:'unscheduled'});return p; },
};
for (const [kind,makePlan] of Object.entries(prohibitedPlans)) {
  for (const draftState of ['intake','confirmation']) {
    test(`review blocks model ${kind} and preserves existing ${draftState}, choices and all business records`, async t => {
      const f=fixture(t);
      await f.run(emptySecretaryIntent('chat',previousAnswer),{...owner,text:question,responseMessageId:'GENERAL-ANSWER'});
      if (draftState==='intake') {
        const started=await f.run(undefined,{...owner,text:'اضف مهمه تجربة الحفظ'},noInference);
        assert.ok(started.choices);assert.ok(f.db.prepare('SELECT * FROM secretary_task_intake').get());
      } else {
        const plan=emptySecretaryIntent('task_draft');plan.intakeMode='start';plan.projectId='p';
        Object.assign(plan.fields,{title:'تجربة حفظ المعاينة',ownerId:'member',priority:'yellow',dueDate:'unscheduled'});
        const preview=await f.run(plan,{...owner,text:'جهز مهمة جديدة في مشروع تجريبي لخالد بأولوية متوسطة وبدون موعد'});
        assert.equal(preview.status,'confirmation');assert.ok(f.db.prepare('SELECT * FROM secretary_pending').get());
      }
      const before=businessSnapshot(f.db);const inputs=[];
      const result=await handleSecretaryEvent(f.db,f.event({...owner,text:'جوابك غلط',replyToMessageId:'GENERAL-ANSWER'}),f.config,{
        infer:async input=>{inputs.push(input);return makePlan(f.now);},
        search:forbiddenProvider(t,'search'),now:()=>f.now,
      });
      assert.equal(inputs.length,1);assert.deepEqual(inputs[0].review,{previousQuestion:question,previousAnswer});assert.equal(inputs[0].taskDraft,null);
      assert.equal(result.status,'clarify');assert.equal(result.choices,undefined);assert.equal(result.batchId,undefined);
      assert.deepEqual(businessSnapshot(f.db),before);
    });
  }
}

test('even an allowed conversational review preserves active intake and opaque choices', async t => {
  const f=fixture(t);
  await f.run(emptySecretaryIntent('chat',previousAnswer),{...owner,text:question,responseMessageId:'GENERAL-ANSWER'});
  await f.run(undefined,{...owner,text:'اضف مهمه تجربة الحفظ'},noInference);
  const before=businessSnapshot(f.db);let inputSeen;
  const result=await handleSecretaryEvent(f.db,f.event({...owner,text:'راجع جوابك',replyToMessageId:'GENERAL-ANSWER'}),f.config,{
    infer:async input=>{inputSeen=input;return emptySecretaryIntent('chat','تصحيح محدد للسؤال السابق.');},search:forbiddenProvider(t,'search'),now:()=>f.now,
  });
  assert.ok(inputSeen.review);assert.equal(result.status,'summary');assert.deepEqual(businessSnapshot(f.db),before);
});

test('review of red tasks uses fresh scoped database facts without model or public search', async t => {
  const f=fixture(t);
  const first=await f.run(undefined,{...owner,text:'اعطيني المهام الحمراء'},noInference);
  assert.match(first.reply,/لوحة/);assert.doesNotMatch(first.reply,/مهمة شادي/);
  f.db.exec("UPDATE tasks SET priority='green',updated_at=2 WHERE id='t'; UPDATE tasks SET priority='red',title='عنوان محدث من قاعدة البيانات',updated_at=2 WHERE id='private'");
  const before=businessSnapshot(f.db);
  const result=await handleSecretaryEvent(f.db,f.event({...owner,text:'جوابك غلط'}),f.config,noProviders(t,f));
  assert.equal(result.status,'summary');assert.match(result.reply,/عنوان محدث من قاعدة البيانات/);assert.match(result.reply,/🔴/);
  assert.doesNotMatch(result.reply,/\*لوحة\*/);assert.deepEqual(businessSnapshot(f.db),before);
});

test('quoted review selects the quoted response question, not the latest different question', async t => {
  const f=fixture(t);
  await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question,responseMessageId:'DISPLAY-ANSWER'});
  await f.run(emptySecretaryIntent('chat','الماء يغلي عند درجة ثابتة دائمًا.'),{text:'كيف يؤثر الارتفاع على غليان الماء؟',responseMessageId:'WATER-ANSWER'});
  const searches=[];let inputSeen;
  await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط',replyToMessageId:'DISPLAY-ANSWER'}),f.config,{
    infer:async input=>{inputSeen=input;return emptySecretaryIntent('search','Unrelated public model query');},
    search:async query=>{searches.push(query);return 'نتيجة تحقق';},now:()=>f.now,
  });
  assert.deepEqual(inputSeen.review,{previousQuestion:question,previousAnswer});assert.deepEqual(searches,[question]);
});

test('review cannot borrow another actor or group conversation, even with a known response ID', async t => {
  const f=fixture(t);const details=emptySecretaryIntent('details');details.taskId='private';
  const answer=await f.run(details,{...owner,text:'شو تفاصيل مهمة شادي الخاصة؟',responseMessageId:'OWNER-PRIVATE'});
  assert.match(answer.reply,/تفاصيل سرية/);
  for (const extra of [
    {text:'جوابك غلط'},
    {text:'جوابك غلط',replyToMessageId:'OWNER-PRIVATE'},
  ]) {
    const result=await handleSecretaryEvent(f.db,f.event(extra),f.config,noProviders(t,f));
    assert.equal(result.status,'clarify');assert.doesNotMatch(result.reply,/تفاصيل سرية|مهمة شادي|private/);
  }
  // Group-origin, even the owner's own, never reaches the review/borrow logic
  // at all -- the blanket event.groupId gate returns a silent denial first.
  const groupResult=await handleSecretaryEvent(f.db,f.event({...owner,groupId:'12345@g.us',text:'جوابك غلط',replyToMessageId:'OWNER-PRIVATE'}),f.config,noProviders(t,f));
  assert.equal(groupResult.status,'denied');assert.equal(groupResult.reply,'');
});

test('current member scope limits review history and rejects a model-selected foreign task', async t => {
  const f=fixture(t);
  await f.run(emptySecretaryIntent('chat','تفاصيل سرية للمالك فقط'),{...owner,text:'شو تفاصيل مهمة شادي الخاصة؟'});
  await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
  let inputSeen;
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,{
    infer:async input=>{
      inputSeen=input;
      const plan=emptySecretaryIntent('details');plan.taskId='private';return plan;
    },search:forbiddenProvider(t,'search'),now:()=>f.now,
  });
  assert.deepEqual(inputSeen.review,{previousQuestion:question,previousAnswer});assert.deepEqual(inputSeen.tasks.map(task=>task.id),['t']);
  assert.doesNotMatch(JSON.stringify(inputSeen),/تفاصيل سرية|مهمة شادي|1202555010/);
  assert.equal(result.status,'clarify');assert.doesNotMatch(result.reply,/تفاصيل سرية|مهمة شادي|private/);
});

test('loss of task visibility removes the previous answer from review and quote context', async t => {
  const f=fixture(t);await f.run(undefined,{text:'شو مهامي؟',responseMessageId:'OLD-TASKS'});
  f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='t'");
  for (const extra of [{text:'جوابك غلط'},{text:'جوابك غلط',replyToMessageId:'OLD-TASKS'}]) {
    const result=await handleSecretaryEvent(f.db,f.event(extra),f.config,noProviders(t,f));
    assert.equal(result.status,'clarify');assert.doesNotMatch(result.reply,/لوحة|تفاصيل تنفيذ|task=t/);
  }
});

test('unregistered or deactivated identity cannot review or receive identity/history responses', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
  f.db.exec("UPDATE users SET active=0 WHERE id='member'");
  for (const extra of [{text:'جوابك غلط'},{text:'مين انت'},{text:'جوابك غلط',senderNumber:'12025550999'}]) {
    const result=await handleSecretaryEvent(f.db,f.event(extra),f.config,noProviders(t,f));
    assert.equal(result.status,'denied');assert.equal(result.reply,'');
  }
});

test('permissions revoked while review inference is pending prevent the result from being exposed', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,{
    infer:async()=>{f.db.exec("UPDATE users SET active=0 WHERE id='member'");return emptySecretaryIntent('chat','لا يجوز كشف هذا الرد');},search:forbiddenProvider(t,'search'),now:()=>f.now,
  });
  assert.equal(result.status,'denied');assert.equal(result.reply,'');
});

test('duplicate review event reuses its receipt and never repeats inference or search', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
  const event=f.event({text:'جوابك غلط',messageId:'REVIEW-ONCE'});let inferred=0,searched=0;
  const deps={infer:async()=>{inferred++;return emptySecretaryIntent('search','Public search query');},search:async()=>{searched++;return 'جواب تحقق واحد';},now:()=>f.now};
  const first=await handleSecretaryEvent(f.db,event,f.config,deps);
  const second=await handleSecretaryEvent(f.db,event,f.config,deps);
  assert.equal(second.status,'duplicate');assert.equal(second.reply,first.reply);assert.equal(inferred,1);assert.equal(searched,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_events').get().n,2);
});

for (const failure of ['infer','invalid-plan','search']) {
  test(`review ${failure} failure returns a stored clarification instead of escaping as an unavailable request`, async t => {
    const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question});
    const before=businessSnapshot(f.db);const event=f.event({text:'جوابك غلط'});let inferred=0,searched=0;
    const result=await handleSecretaryEvent(f.db,event,f.config,{
      infer:async()=>{
        inferred++;
        if(failure==='infer')throw Error('synthetic provider failure');
        if(failure==='invalid-plan')return {kind:'command'};
        return emptySecretaryIntent('search','Public search query');
      },
      search:async()=>{searched++;throw Error('synthetic search failure');},now:()=>f.now,
    });
    assert.equal(result.status,'clarify');assert.ok(result.reply.trim());assert.doesNotMatch(result.reply,/synthetic/);
    assert.equal(inferred,1);assert.equal(searched,failure==='search'?1:0);assert.deepEqual(businessSnapshot(f.db),before);
    assert.equal((await handleSecretaryEvent(f.db,event,f.config,noProviders(t,f))).status,'duplicate');
  });
}

test('review never sends an internal prior question to public search even if the model supplies a harmless query', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('summary'),{text:'شو حالة لوحة في مشروع تجريبي؟'});
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,{
    infer:async()=>emptySecretaryIntent('search','Public productivity tips'),search:forbiddenProvider(t,'search'),now:()=>f.now,
  });
  assert.ok(result.reply.trim());assert.doesNotMatch(result.reply,/https?:\/\//);
});

test('review blocks prior password and spaced phone questions despite a harmless model search query', async t => {
  const f=fixture(t);
  for (const privateQuestion of [
    'ما هي كلمة السر الخاصة abcDEF_example؟',
    'ما هو هذا الرقم 1 202 555 0104؟',
    'ما هو هذا الرقم ١ ٢٠٢ ٥٥٥ ٠١٠٤؟',
  ]) {
    const answer='هذه معلومة خاصة لا أملك مصدرًا للتحقق منها.';
    await f.run(emptySecretaryIntent('chat',answer),{text:privateQuestion});
    const before=businessSnapshot(f.db);let inputSeen;
    const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط'}),f.config,{
      infer:async input=>{inputSeen=input;return emptySecretaryIntent('search','Public information lookup');},
      search:forbiddenProvider(t,'search'),now:()=>f.now,
    });
    assert.deepEqual(inputSeen.review,{previousQuestion:privateQuestion,previousAnswer:answer});
    assert.ok(result.reply.trim());assert.doesNotMatch(result.reply,/abcDEF_example|555|٥٥٥|https?:\/\//);
    assert.deepEqual(businessSnapshot(f.db),before);
  }
});

test('quoting an older review after a newer question stays anchored to the reviewed question and answer', async t => {
  const f=fixture(t);
  await f.run(emptySecretaryIntent('chat',previousAnswer),{text:question,responseMessageId:'ANSWER-A'});
  const reviewAnswer='التصحيح الأول: توجد فروق في تقنية إضاءة الشاشة.';
  const reviewed=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط',responseMessageId:'REVIEW-A'}),f.config,{
    infer:async()=>emptySecretaryIntent('chat',reviewAnswer),search:forbiddenProvider(t,'search'),now:()=>f.now,
  });
  assert.equal(reviewed.reply,reviewAnswer);
  // Equal timestamps exercise the stored event sequence, not just a time cutoff.
  await f.run(emptySecretaryIntent('chat','جواب السؤال الأحدث عن الماء.'),{text:'كيف يؤثر الارتفاع على غليان الماء؟',responseMessageId:'ANSWER-B'});
  const before=businessSnapshot(f.db);const searches=[];let inputSeen;
  const result=await handleSecretaryEvent(f.db,f.event({text:'جوابك غلط',replyToMessageId:'REVIEW-A'}),f.config,{
    infer:async input=>{inputSeen=input;return emptySecretaryIntent('search','Different public model query');},
    search:async query=>{searches.push(query);return 'تحقق جديد للسؤال الأصلي https://example.com/displays';},now:()=>f.now,
  });
  assert.deepEqual(inputSeen.review,{previousQuestion:question,previousAnswer:reviewAnswer});
  assert.deepEqual(searches,[question]);assert.match(result.reply,/https:\/\/example.com\/displays/);
  assert.deepEqual(businessSnapshot(f.db),before);
});

test('criticism combined with a new send or deletion is clarification, not execution or replanning', async t => {
  const f=fixture(t);await f.run(emptySecretaryIntent('chat',previousAnswer),{...owner,text:question});
  const before=businessSnapshot(f.db);
  for (const text of ['جوابك غلط، ابعث للتيم التصحيح','راجع جوابك واحذف المهمة']) {
    const result=await handleSecretaryEvent(f.db,f.event({...owner,text}),f.config,noProviders(t,f));
    assert.equal(result.status,'clarify');assert.deepEqual(businessSnapshot(f.db),before);
  }
});
