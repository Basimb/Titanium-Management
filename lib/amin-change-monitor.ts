import {watch,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {enqueueAgentMessage} from './agent-followups.ts';
import {formatAminChangeNotice,isReportableAudit} from './amin-change-notice.ts';
import {readVerifiedChangeReceipts} from './amin-change-receipts.ts';
import {readConnectorChanges} from './amin-connector-changes.ts';

// باسم ١٦/١٠/٢٠٢٦: إيقاف مؤقت لإشعارات التغييرات — الملف فيه {"until": ISO}. بعد الموعد بترجع لحالها.
function aminNoticesPaused(t:number){try{const j=JSON.parse(readFileSync('/home/titani24/qa_data/amin/change-notices-pause.json','utf8'));return t<Date.parse(j.until);}catch{return false;}}

/** Observe recorded management writes and selected application source paths.
 * Does not claim universal coverage or infer an author. Hashes never export file contents.
 */
export function createAminChangeMonitor(options:{db:DatabaseSync;enabled:()=>boolean;roots?:string[];now?:()=>number;observeFiles?:boolean;receiptDirectory?:string;connectorDirectory?:string}){
 const {db}=options,now=options.now||Date.now;
 db.exec('CREATE TABLE IF NOT EXISTS amin_change_cursor (key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS amin_file_changes (id INTEGER PRIMARY KEY,path TEXT NOT NULL,change TEXT NOT NULL,observed_at INTEGER NOT NULL,actor TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS amin_file_fingerprints (path TEXT PRIMARY KEY,digest TEXT NOT NULL)');
 // Retain obsolete notices in the audit store, but prevent pending vague alerts from being delivered.
 db.prepare("UPDATE agent_outbox SET state='failed' WHERE source='amin_audit' AND state='pending' AND (text LIKE '%رصدت تعديلًا في%' OR text LIKE '%هوية المعدّل غير متاحة%')").run();
 if(!db.prepare("SELECT value FROM amin_change_cursor WHERE key='audit'").get()){
  const first=db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit_logs').get() as {id:number};
  db.prepare("INSERT INTO amin_change_cursor VALUES('audit',?)").run(first.id);
 }
 const files=new Map<string,string>(),watchers:ReturnType<typeof watch>[]=[],unavailable=new Set<string>();
 let stopped=false;
 const noteFile=(root:string,filename:string|null)=>{
  if(stopped||!filename)return;
  const rel=String(filename).replace(/\\/g,'/');
  if(rel.startsWith('/')||rel.split('/').some(x=>x==='..'||['node_modules','.git','vendor','cache','tmp','mcp-files','tests','test','__tests__','fixtures','work'].includes(x))||/(?:^|[\/._-])(?:tests?|spec|probes?|diagnostics?|health|cache|backup)(?:[\/._-]|$)/i.test(rel)||/\.(?:log|lock|sqlite|db|bak)(?:[.-]|$)/i.test(rel)||! /\.(?:php|ts|mjs|js|css|html|json|md)$/i.test(rel))return;
  const absolute=path.resolve(root,rel),base=path.resolve(root);
  if(!absolute.startsWith(base+path.sep))return;
  if(files.size<2000)files.set(absolute,'pending');
 };
 if(options.observeFiles!==false)for(const root of options.roots||[]){
  try{const w=watch(root,{recursive:true,persistent:false},(_event,name)=>noteFile(root,name===null?null:String(name)));w.on('error',()=>unavailable.add(root));watchers.push(w);}catch{unavailable.add(root);}
 }
 // Establish current contents before the first edit; an initial read is never a change alert.
 let visited=0;
 const seed=(root:string,dir:string,depth=0)=>{
  if(depth>15||visited>10000)return;
  try{for(const e of readdirSync(dir,{withFileTypes:true})){
   if(++visited>10000)return;
   if(e.isSymbolicLink())continue;
   const full=path.join(dir,e.name),rel=path.relative(root,full).replace(/\\/g,'/');
   if(e.isDirectory()){
    if(!['node_modules','.git','vendor','cache','tmp','mcp-files','tests','test','__tests__','fixtures','work'].includes(e.name))seed(root,full,depth+1);
   }else if(e.isFile())noteFile(root,rel);
  }}catch{unavailable.add(root);}
 };
 for(const root of options.roots||[])seed(path.resolve(root),path.resolve(root));
 for(const [file] of files){try{const s=lstatSync(file);if(s.isFile()&&!s.isSymbolicLink()&&s.size<=4_000_000)db.prepare('INSERT OR IGNORE INTO amin_file_fingerprints VALUES(?,?)').run(file,createHash('sha256').update(readFileSync(file)).digest('hex'));}catch{}}
 files.clear();
 return {
  noteFile,
  coverage:()=>({audit:'management audit_logs only',paths:options.roots||[],unavailable:[...unavailable],universalServerGate:false,otherChatsConnected:false}),
  tick(){
   if(stopped||!options.enabled())return {queued:false};
   const owner=db.prepare("SELECT id FROM users WHERE id='basem' AND role='admin' AND active=1").get();if(!owner)return {queued:false};
   db.exec('BEGIN IMMEDIATE');
   try{
    const cursor=Number((db.prepare("SELECT value FROM amin_change_cursor WHERE key='audit'").get() as {value:number}).value);
    const rows=db.prepare('SELECT id,actor_user_id,actor_name,action,entity_type,entity_id,details,created_at FROM audit_logs WHERE id>? ORDER BY id LIMIT 100').all(cursor) as Array<{id:number;actor_user_id:string;actor_name:string;action:string;entity_type:string;entity_id:string;details:string;created_at:number}>;
   const changes=rows.filter(isReportableAudit),paths:Array<{path:string;change:string}>=[];
    for(const [file] of files){
     let hash='missing';try{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>4_000_000)continue;hash=createHash('sha256').update(readFileSync(file)).digest('hex');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue;}
     const previous=db.prepare('SELECT digest FROM amin_file_fingerprints WHERE path=?').get(file) as {digest:string}|undefined;
     db.prepare('INSERT OR REPLACE INTO amin_file_fingerprints VALUES(?,?)').run(file,hash);
     const before=previous?.digest||'missing';if(before===hash)continue;
     const change=before+' -> '+hash;paths.push({path:file,change});db.prepare('INSERT INTO amin_file_changes(path,change,observed_at,actor) VALUES(?,?,?,?)').run(file,change,now(),'unknown');
    }
    const receipts=[...readVerifiedChangeReceipts(db,options.receiptDirectory||'/home/titani24/qa_data/amin/change-notices',options.roots||[]),...readConnectorChanges(db,options.connectorDirectory)];
    const notice=formatAminChangeNotice(changes,receipts,now(),paths);
    if(notice){
     if(!aminNoticesPaused(now()))enqueueAgentMessage(db,{toUser:'basem',source:'amin_audit',text:notice},now());
     for(const r of receipts)db.prepare('INSERT INTO amin_change_cursor VALUES(?,?)').run('receipt:'+r.id+'.json',now());
    }
    if(rows.length)db.prepare("UPDATE amin_change_cursor SET value=? WHERE key='audit'").run(rows.at(-1)!.id);
    db.exec('COMMIT');files.clear();return {queued:!!notice,auditRows:rows.length,fileChanges:paths.length};
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  stop(){stopped=true;for(const w of watchers)w.close();files.clear();}
 };
}

