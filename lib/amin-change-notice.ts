export type AuditChange={actor_user_id?:string;actor_name:string;action:string;entity_type:string;entity_id:string;details?:string};
export type VerifiedChange={id:string;summary:string;actor:{id:string;name:string};files:Array<{path:string;before_md5:string;after_md5:string}>};
export type ObservedFileChange={path:string;change:string};
const clean=(s:string,n=50)=>s.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,n);
const actions:Record<string,string>={
 edit_task:'عدّل مهمة',add_task:'أضاف مهمة',task_create:'أضاف مهمة',claim:'استلم مهمة',
 submit:'رفع مهمة للاعتماد',approve:'اعتمد طلبًا',reject:'رفض طلبًا',reassign:'غيّر مسؤول مهمة',
 archive_task:'أرشف مهمة',delete_task:'حذف مهمة',comment:'أضاف ملاحظة على مهمة',
 knowledge_add:'أضاف معلومة لمرجع العمل',knowledge_remove:'حذف معلومة من مرجع العمل',
 create:'أضاف مهمة',edit:'عدّل مهمة',delete:'حذف مهمة',unclaim:'ألغى استلام مهمة',reopen:'أعاد فتح مهمة',
 archive:'أرشف مهمة',restore:'استرجع مهمة من الأرشيف',watch:'غيّر متابع المهمة',blocker:'غيّر معطّل المهمة',expected:'غيّر موعد الإنجاز المتوقع',
 secretary_playbook_updated:'حدّث تعليمات أمين الدائمة',
};
export function isReportableAudit(row:AuditChange){
 let detail:any={};try{detail=JSON.parse(row.details||'{}');}catch{}
 const event=String(row.action||'').toLowerCase(),entity=String(detail.model||row.entity_type||'').toLowerCase();
 // Sales transactions are excluded; editing product prices or sales code is still a change.
 if(/^(?:pos[._]order(?:[._]line)?|sale[._]order(?:[._]line)?|sales?|sale_transaction)$/.test(entity)||/^(?:sale|sales)(?:[._:-](?:create|created|update|updated|complete|completed|record|recorded))?$/.test(event)||['out_invoice','out_refund'].includes(detail.move_type))return false;
 if(/(?:^|[._:-])(?:read|check|inspect|search|list|fetch|status|health|preview|probe|test)(?:$|[._:-])/.test(event))return false;
 let actualDiff=false;
 if(detail.previous&&detail.next){
  const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>!['updatedAt','updated_at','createdAt','created_at','lastUpdateAt','last_update_at'].includes(k)).map(k=>[k,stable(v[k])])):v;
  actualDiff=JSON.stringify(stable(detail.previous))!==JSON.stringify(stable(detail.next));
  if(!actualDiff)return false;
 }
 if(!actions[row.action]&&!actualDiff&&!/(?:^|[._:-])(?:create|created|add|added|edit|edited|update|updated|write|delete|deleted|remove|removed|archive|restore|approve|reject|change|changed|save)(?:$|[._:-])/.test(event))return false;
 return detail.synthetic!==true&&detail.test!==true&&detail.dryRun!==true&&detail.environment!=='test'&&detail.changed!==false;
}
/** Describe what was observed, without inventing purpose, author, approval or success. */
export function formatAminChangeNotice(audits:AuditChange[],receipts:VerifiedChange[],now:number,files:ObservedFileChange[]=[]){
 const lines:string[]=[];
 const changes=new Map<string,number>();
 for(const r of audits.filter(isReportableAudit)){
  let detail:any={};try{detail=JSON.parse(r.details||'{}');}catch{}
  const explicit=[detail.changeSummary,detail.change_summary,detail.summary].find(v=>typeof v==='string'&&v.trim()&&v!=='محادثة سكرتير الإدارة');
  const title=[detail.taskTitle,detail.title,detail.next?.title,detail.previous?.title].find(v=>typeof v==='string'&&v.trim());
  const entities:Record<string,string>={task:'مهمة',product:'صنف',supplier:'مورّد',stock:'مخزون',purchase:'مشتريات',rule:'قاعدة عمل',knowledge:'معلومة عمل'};
  const action=explicit?clean(explicit,180):(actions[r.action]||'تغيّرت بيانات '+(entities[r.entity_type]||'العمل'))+(title?' — '+clean(title,130):'');
  const label=action+(r.actor_name?.trim()?'؛ المسؤول: '+clean(r.actor_name):'؛ اسم المنفّذ غير متاح في السجل');
  changes.set(label,(changes.get(label)||0)+1);
 }
 for(const [label,count]of [...changes].slice(0,4))lines.push('• '+label+(count>1?' ('+count+' مرات)':'')+'.');
 for(const r of receipts.slice(0,4))lines.push('• '+clean(r.summary,220)+'\n  المسؤول المسجّل: '+clean(r.actor.name)+'.');
 const explained=new Set(receipts.flatMap(r=>r.files.map(f=>f.path)));
 const uncovered=files.filter(f=>!explained.has(f.path));
 for(const f of uncovered.slice(0,4)){
  const name=clean(f.path.replace(/\\/g,'/').split('/').pop()||'ملف',100);
  const area=f.path.includes('/idara/')?'موقع إدارة':f.path.includes('/amin/')?'أمين':'نظام أمين';
  const verb=f.change.endsWith(' -> missing')?'انحذف':f.change.startsWith('missing -> ')?'انضاف':'تغيّر محتوى';
  lines.push('• '+verb+' ملف «'+name+'» في '+area+'؛ اسم المنفّذ ووصف التعديل غير متاحين.');
 }
 if(!lines.length)return '';
 if(receipts.length>4||changes.size>4||uncovered.length>4)lines.push('• تغييرات إضافية محفوظة في السجل.');
 const when=new Intl.DateTimeFormat('ar-JO',{timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit'}).format(now);
 return '🛡️ أمين — تغييرات '+when+'\n'+lines.join('\n');
}

