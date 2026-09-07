import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTasks, overdue, overdueDays, pages, taskRank } from '../components/tv-dashboard-model.ts';
const task=(overrides={})=>({id:'t',projectId:'p',title:'مهمة',details:'',priority:'red',status:'open',owner:null,suggestedOwner:null,dueDate:'2026-09-06',...overrides});
test('delay count uses Amman calendar dates across months and excludes completed work',()=>{
 const now=Date.parse('2026-09-02T21:01:00Z');
 assert.equal(overdueDays(task({dueDate:'2026-08-31'}),now),3);
 assert.equal(overdueDays(task({dueDate:'2026-09-03'}),now),0);
 assert.equal(overdueDays(task({dueDate:'2026-08-31',status:'completed'}),now),0);
 assert.equal(overdueDays(task({dueDate:'2026-02-31'}),now),0);
});
test('TV rotates every task without dropping the last partial page',()=>{
 const items=Array.from({length:24},(_,i)=>task({id:String(i)}));const result=pages(items,5);
 assert.equal(result.length,5);assert.deepEqual(result.flat(),items);assert.equal(result.at(-1).length,4);assert.deepEqual(pages([],5),[[]]);
});
test('TV excludes archived tasks and rejected or archived projects',()=>{
 const data={projects:[{id:'p',status:'active'},{id:'old',status:'active',archivedAt:12},{id:'rejected',status:'rejected'}],tasks:[task(),task({id:'old-task',archivedAt:4}),task({id:'old-project',projectId:'old'}),task({id:'rejected-project',projectId:'rejected'}),task({id:'unknown',projectId:'missing'})]};
 assert.deepEqual(activeTasks(data).map(t=>t.id),['t']);
});
test('overdue changes at Amman midnight and never marks completed or undated work late',()=>{
 assert.equal(overdue(task(),Date.parse('2026-09-06T20:59:59Z')),false);
 assert.equal(overdue(task(),Date.parse('2026-09-06T21:00:00Z')),true);
 assert.equal(overdue(task({status:'completed'}),Date.parse('2026-09-07T21:00:00Z')),false);
 assert.equal(overdue(task({dueDate:null}),Date.parse('2026-09-07T21:00:00Z')),false);
});
test('unfinished blockers and overdue work precede completed high-priority work',()=>{
 const now=Date.parse('2026-09-07T12:00:00Z');assert.ok(taskRank(task({blocker:'بانتظار'}),now)<taskRank(task(),now));assert.ok(taskRank(task(),now)<taskRank(task({status:'completed'}),now));
});
