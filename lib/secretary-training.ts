import {readFileSync,statSync} from 'node:fs';
/** Live teaching, loaded per message. Lessons guide reasoning, never grant permissions. */
export function currentAminLessons():Array<{id:string;guidance:string}> {
  try{
    const file=new URL('./amin-training.json',import.meta.url);
    if(statSync(file).size>32000)return [];
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(value.version!==1 || !Array.isArray(value.lessons)||value.lessons.length>30)return [];
    if(!value.lessons.every((x:unknown)=>x && typeof x==='object' && typeof (x as any).id==='string' && (x as any).id.length<=80 && typeof (x as any).guidance==='string' && (x as any).guidance.length<=1200))return [];
    return value.lessons.map((x:{id:string;guidance:string})=>({id:x.id,guidance:x.guidance}));
  }catch{return [];}
}
