/** Evidence index for authenticated WhatsApp requests; never an authorization source. */
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

type Outcome={eventKey:string;payloadHash:string;actorId:string;conversationKey:string;sourceMessageId:string;
 replyToMessageId?:string|null;responseMessageId?:string|null;sourceKind?:string;status:string;taskId?:string;batchId?:string;scope:string[];now:number};
type Row={event_key:string;actor_id:string;conversation_key:string;root_event_key:string;source_message_id:string;stage:string;next_step:string;
 source_status:string;task_id:string|null;batch_id:string|null;server_job_id:string|null;scope_json:string;root_scope_json:string;updated_at:number;question:string|null};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export function migrateAminRequestLifecycle(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS amin_request_lifecycle(
 event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_key TEXT NOT NULL,
 source_message_id TEXT NOT NULL,root_event_key TEXT NOT NULL,parent_event_key TEXT,source_kind TEXT NOT NULL,
 source_status TEXT NOT NULL,stage TEXT NOT NULL,next_step TEXT NOT NULL,response_message_id TEXT,
 task_id TEXT,batch_id TEXT,server_job_id TEXT,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS amin_request_actor ON amin_request_lifecycle(actor_id,conversation_key,updated_at);
 CREATE TABLE IF NOT EXISTS amin_request_evidence(
 id TEXT PRIMARY KEY,event_key TEXT NOT NULL,stage TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,created_at INTEGER NOT NULL);
 `);}
export function lifecycleStage(status:string):{stage:string;next:string}{
 switch(status){
  case 'clarify':return {stage:'waiting_info',next:'collect_missing_information'};
  case 'confirmation':case 'pending':return {stage:'waiting_approval',next:'await_matching_approval'};
  case 'queued':return {stage:'queued',next:'inspect_execution_or_delivery_result'};
  case 'scheduled':return {stage:'scheduled',next:'await_registered_due_time'};
  case 'applied':return {stage:'executed',next:'inspect_recorded_operation_result'};
  case 'cancelled':return {stage:'cancelled',next:'none'};
  case 'denied':return {stage:'denied',next:'none'};
  case 'stale':return {stage:'needs_review',next:'review_current_version'};
  case 'summary':return {stage:'answered',next:'none'};
  default:return {stage:'unverified',next:'inspect_source_result'};
 }
}
export function recordAminRequestOutcome(db:DatabaseSync,input:Outcome){
 if(!db.isTransaction)throw Error('REQUEST_LIFECYCLE_REQUIRES_EVENT_TRANSACTION');
 const old=db.prepare('SELECT payload_hash,actor_id,conversation_key FROM amin_request_lifecycle WHERE event_key=?').get(input.eventKey) as any;
 if(old){if(old.payload_hash!==input.payloadHash||old.actor_id!==input.actorId||old.conversation_key!==input.conversationKey)throw Error('REQUEST_LIFECYCLE_ID_CONFLICT');return;}
 let parent:Row|undefined;
 // Only an explicit reply to a recorded message links requests; no "last task" guessing.
 if(input.replyToMessageId)parent=db.prepare(`SELECT * FROM amin_request_lifecycle WHERE actor_id=? AND conversation_key=?
 AND (source_message_id=? OR response_message_id=?) ORDER BY updated_at DESC,rowid DESC LIMIT 1`)
 .get(input.actorId,input.conversationKey,input.replyToMessageId,input.replyToMessageId) as Row|undefined;
 const phase=lifecycleStage(input.status),serverId=digest('amin-server:'+input.eventKey);
 const server=db.prepare('SELECT id FROM amin_server_jobs WHERE id=? AND actor_id=? AND conversation_key=?').get(serverId,input.actorId,input.conversationKey) as {id:string}|undefined;
 db.prepare('INSERT INTO amin_request_lifecycle VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.eventKey,input.payloadHash,input.actorId,input.conversationKey,
 input.sourceMessageId,parent?.root_event_key||input.eventKey,parent?.event_key||null,input.sourceKind==='voice'?'voice':'text',input.status,phase.stage,phase.next,
 input.responseMessageId||null,input.taskId||null,input.batchId||null,server?.id||null,JSON.stringify(input.scope),input.now,input.now);
 for(const [stage,kind,reference]of [['received','stored_event','secretary_events:'+input.eventKey],[phase.stage,'source_outcome','secretary_events:'+input.eventKey]]){
  const id=digest(input.eventKey+':'+stage+':'+kind);
  db.prepare('INSERT INTO amin_request_evidence VALUES(?,?,?,?,?,?)').run(id,input.eventKey,stage,kind,reference,input.now);
 }
}
export function aminRequestContext(db:DatabaseSync,input:{actorId:string;conversationKey:string;allowedScope:Set<string>;now:number}){
 const rows=db.prepare(`SELECT l.*,r.scope_json AS root_scope_json,s.original_text AS question FROM amin_request_lifecycle l
 JOIN amin_request_lifecycle r ON r.event_key=l.root_event_key AND r.actor_id=l.actor_id AND r.conversation_key=l.conversation_key
 LEFT JOIN secretary_events s ON s.event_key=l.root_event_key AND s.actor_id=l.actor_id AND s.conversation_key=l.conversation_key
 WHERE l.actor_id=? AND l.conversation_key=? ORDER BY l.updated_at DESC,l.rowid DESC LIMIT 60`).all(input.actorId,input.conversationKey) as Row[];
 const seen=new Set<string>(),out:Array<{requestId:string;question:string;stage:string;nextStep:string;sourceMessageId:string;execution:string;delivery:string}>=[];
 for(const row of rows){
  if(seen.has(row.root_event_key))continue;seen.add(row.root_event_key);
  const scope=JSON.parse(row.scope_json),rootScope=JSON.parse(row.root_scope_json);
  if(!Array.isArray(scope)||!Array.isArray(rootScope)||![...scope,...rootScope].every(x=>input.allowedScope.has(x)))continue;
  let stage=row.stage,next=row.next_step,execution=row.source_status;
  if(row.server_job_id){
   const job=db.prepare('SELECT status FROM amin_server_jobs WHERE id=? AND actor_id=? AND conversation_key=?').get(row.server_job_id,input.actorId,input.conversationKey) as {status:string}|undefined;
   if(job){stage=job.status;execution=job.status;next=job.status==='waiting_approval'?'await_matching_approval':job.status==='completed'?'none':job.status==='uncertain'?'inspect_without_replay':'inspect_server_job';}
  }
  if(['answered','cancelled','denied','completed','rejected'].includes(stage))continue;
  out.push({requestId:row.root_event_key,question:(row.question||'').slice(0,350),stage,nextStep:next,sourceMessageId:row.source_message_id,
   execution,delivery:'not_confirmed'});
  if(out.length===6)break;
 }
 return out;
}
