import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {VerifiedChange} from './amin-change-notice.ts';
const md5=/^[a-f0-9]{32}$/;
export function readVerifiedChangeReceipts(db:DatabaseSync,directory:string,roots:string[]):VerifiedChange[]{
 const rows:VerifiedChange[]=[];let names:string[]=[];
 try{const s=lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink())return rows;names=readdirSync(directory).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).sort();}catch{return rows;}
 for(const name of names.slice(0,1000)){
  if(db.prepare("SELECT value FROM amin_change_cursor WHERE key=?").get('receipt:'+name))continue;
  try{
   const filename=path.join(directory,name),s=lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||s.size>16000)continue;
   const r=JSON.parse(readFileSync(filename,'utf8'));
   if(r.v!==1||r.id+'.json'!==name||r.environment!=='production'||r.operation!=='change'||r.status!=='verified'||r.synthetic===true||r.test===true||typeof r.summary!=='string'||r.summary.trim().length<8||r.summary.length>300||!r.actor||typeof r.actor.id!=='string'||!r.actor.id.trim()||typeof r.actor.name!=='string'||!r.actor.name.trim()||!Array.isArray(r.files)||!r.files.length||r.files.length>20)continue;
   let valid=true;
   for(const f of r.files){
    if(typeof f.path!=='string'||!path.isAbsolute(f.path)||(f.before_md5!=='missing'&&!md5.test(f.before_md5))||!md5.test(f.after_md5)||f.before_md5===f.after_md5||!roots.some(root=>f.path.startsWith(path.resolve(root)+path.sep))){valid=false;break;}
    const stat=lstatSync(f.path);
    if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(f.path)!==f.path||stat.size>4_000_000||createHash('md5').update(readFileSync(f.path)).digest('hex')!==f.after_md5){valid=false;break;}
   }
   if(valid){rows.push(r);if(rows.length>=4)break;}
  }catch{/* Unknown, stale or incomplete evidence remains silent, never attributed. */}
 }
 return rows;
}
