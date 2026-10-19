import test from 'node:test';
import assert from 'node:assert/strict';
import {secretaryBusinessKnowledge} from '../lib/secretary-business-knowledge.ts';
import {isDiscussionOnlyRequest} from '../lib/secretary-conversation-policy.ts';
import {emptySecretaryIntent,validateSecretaryIntent} from '../lib/secretary-intent.ts';
test('work advice cannot become a record mutation, while explicit commands remain actionable',()=>{
 const text='أنا عندي فرق 3 حبات بالصنف اللي بمهمة الجرد، شو أعمل؟';
 assert.equal(isDiscussionOnlyRequest(text),true);
 const input={text,actor:{id:'staff',name:'موظف',role:'member'},tasks:[{id:'count',title:'جرد',status:'progress',priority:'yellow'}],users:[],history:[],now:'2026-10-13T18:00:00Z'};
 const plan={...emptySecretaryIntent('command'),action:'comment',taskId:'count',fields:{...emptySecretaryIntent().fields,body:'فرق 3 حبات'}};
 assert.equal(validateSecretaryIntent(plan,input).kind,'clarify');
 assert.equal(isDiscussionOnlyRequest('سجل ملاحظة فرق 3 حبات'),false);
 assert.equal(isDiscussionOnlyRequest('شو أعمل؟ سجل ملاحظة فرق 3 حبات'),false);
});
test('business knowledge separates owner priorities from permission and historical facts',()=>{
 const data=secretaryBusinessKnowledge('توزيع مخزون 36 وحدة');
 assert.equal(data.scope,'operating-priorities-not-permissions');
 assert.equal(data.trainingCases.length,1);
 assert.equal(data.trainingCases[0].kind,'synthetic_training');
 assert.match(data.trainingCases[0].example,/أ=14 ب=22 ج=0/);
 assert.match(data.trainingCases[0].example,/ليس بيانات فروع/);
 assert.deepEqual(secretaryBusinessKnowledge('مرحبا').trainingCases,[]);
 assert.ok(secretaryBusinessKnowledge('جرد جدول عرض توزيع مخزون').trainingCases.length<=2);
});
