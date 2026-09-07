export type DisplayTask = { id:string; projectId:string; title:string; details:string; priority:string; status:string; owner:string|null; suggestedOwner:string|null; dueDate:string|null; archivedAt?:number|null; blocker?:string|null; watcher?:string|null };
export type DisplayState = {
  projects:Array<{id:string;name:string;status:string;archivedAt?:number|null}>;
  tasks:DisplayTask[];
  users:Array<{id:string;name:string;active:number}>;
  comments:Array<{id:number;taskId:string;author:string;body:string;createdAt:number}>;
  monitoring?:{approvals:Array<{id:string;type:string;status:string;requestedByName:string;summary:string;createdAt:number}>;followups:Array<{id:string;kind:string;targetUser:string;sentAt:number}>};
};
export function ammanDay(now:number) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}
export function overdue(task:DisplayTask,now:number) { return task.status!=='completed' && Boolean(task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) && task.dueDate<ammanDay(now)); }
export function overdueDays(task:DisplayTask,now:number) {
  if(!overdue(task,now))return 0;
  const due=Date.parse(task.dueDate+'T00:00:00Z');
  if(!Number.isFinite(due)||new Date(due).toISOString().slice(0,10)!==task.dueDate)return 0;
  return Math.max(0,Math.round((Date.parse(ammanDay(now)+'T00:00:00Z')-due)/86400000));
}
export function delayLabel(days:number) { return days===1?'متأخرة يومًا واحدًا':days===2?'متأخرة يومين':days<=10?`متأخرة ${days} أيام`:`متأخرة ${days} يومًا`; }
export function activeTasks(data:DisplayState) { const projects=new Set(data.projects.filter(p=>!p.archivedAt&&p.status!=='archived'&&p.status!=='rejected').map(p=>p.id));return data.tasks.filter(t=>!t.archivedAt&&projects.has(t.projectId)); }
const priorityRanks:Record<string,number>={red:0,yellow:1,green:2};
export function taskRank(task:DisplayTask,now:number) { return (task.status==='completed'?100:0)+(task.blocker?0:overdue(task,now)?1:task.status==='approval'?2:3)*10+(priorityRanks[task.priority]??3); }
export function pages<T>(items:T[],size:number):T[][] { if(!items.length)return [[]];return Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size)); }
