import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';import type {DatabaseSync} from 'node:sqlite';
import type {VerifiedChange} from './amin-change-notice.ts';
/** This directory is written by the MCP host and blocked by its file tools. */
export function readConnectorChanges(db:DatabaseSync,directory='/home/titani24/qa_data/amin/connector-identities/changes'):VerifiedChange[]{
 let names:string[]=[];try{if(lstatSync(directory).isSymbolicLink())return[];names=readdirSync(directory).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).sort();}catch{return[];}
 const result:VerifiedChange[]=[];
 for(const n of names){if(db.prepare('SELECT value FROM amin_change_cursor WHERE key=?').get('receipt:connector-'+n))continue;
  try{const file=path.join(directory,n),s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>200000)continue;const r=JSON.parse(readFileSync(file,'utf8'));
   if(r.v!==1||r.id+'.json'!==n||!['completed','partial_or_uncertain'].includes(r.status)||typeof r.actor?.name!=='string'||!r.actor.name.trim()||r.actor.assurance!=='self_declared'||typeof r.summary!=='string'||!Array.isArray(r.files)||!r.files.length)continue;
   // Provider liveness timestamps are checks, not business or source changes.
   if(r.files.every((f:{path?:string})=>typeof f.path==='string'&&/^\/home\/titani24\/qa_data\/amin\/dialogue\/runtime\/(?:gemini|grok)_state\/worker\.json$/.test(f.path))){
    db.prepare('INSERT OR IGNORE INTO amin_change_cursor VALUES(?,?)').run('receipt:connector-'+n,Date.now());continue;
   }
   const actorName=r.actor.name.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,70),rawSource=String(r.actor.source||'موصل Titanium').replace(/[\x00-\x1f]/g,' ').slice(0,50);
   const source=/claude/i.test(rawSource)?'Claude':/chatgpt|codex/i.test(rawSource)?'ChatGPT':/gemini/i.test(rawSource)?'Gemini':/grok/i.test(rawSource)?'Grok':rawSource;
   result.push({id:'connector-'+r.id,summary:(r.status==='partial_or_uncertain'?'تغيير جزئي أو غير مكتمل التحقق: ':'')+r.summary,actor:{id:String(r.actor.id),name:actorName+' عبر '+source+' (اسم صرّح به المستخدم)'},files:r.files});if(result.length>=4)break;
  }catch{}
 }
 return result;
}
