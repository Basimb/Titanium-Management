import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createVoiceTranscriber, validVoiceMetadata, opusDuration, safeVoiceTranscript, selectVoiceIncoming } from '../src/voice.mjs';

function ogg(seconds=1) {
 const head=Buffer.alloc(19);head.write('OpusHead');head[8]=1;head[9]=1;
 const page=(payload,flags,seq,granule)=>{const b=Buffer.alloc(28+payload.length);b.write('OggS');b[5]=flags;b.writeBigInt64LE(BigInt(granule),6);b.writeUInt32LE(1,14);b.writeUInt32LE(seq,18);b[26]=1;b[27]=payload.length;payload.copy(b,28);return b;};
 return Buffer.concat([page(head,2,0,0),page(Buffer.from('packet'),4,1,seconds*48000)]);
}
function audio(bytes=ogg()){return {ptt:true,mimetype:'audio/ogg; codecs=opus',seconds:1,fileLength:bytes.length,mediaKey:Buffer.alloc(32,1),fileSha256:createHash('sha256').update(bytes).digest(),directPath:'/v/t62/voice.enc'};}
test('voice metadata excludes redirects, arbitrary hosts, huge files and nonPTT',()=>{
 const a=audio();assert.equal(validVoiceMetadata(a),true);for(const change of[{seconds:301},{fileLength:11*1024*1024},{ptt:false},{url:'https://evil.example/file'},{directPath:'//evil.example/file'},{mimetype:'video/mp4'}])assert.equal(validVoiceMetadata({...a,...change}),false);
});
test('actual Ogg duration is checked, malformed/chained/overlong streams rejected',()=>{
 assert.equal(opusDuration(ogg(1)),1);assert.throws(()=>opusDuration(ogg(301)));assert.throws(()=>opusDuration(Buffer.from('fake')));assert.throws(()=>opusDuration(Buffer.concat([ogg(),ogg()])));
});

test('complete voice pages without EOS retain duration validation while truncated pages fail',()=>{
 const bytes=ogg(2);bytes[47+5]=0;
 assert.equal(opusDuration(bytes),2);
 assert.throws(()=>opusDuration(bytes.subarray(0,bytes.length-1)));
 const long=ogg(301);long[47+5]=0;assert.throws(()=>opusDuration(long),/voice_duration_exceeded/);
 const invalid=ogg(0);invalid[47+5]=0;assert.throws(()=>opusDuration(invalid),/voice_duration_invalid/);
});
test('login codes and obvious credentials cannot become work transcripts',()=>{
 for(const text of['123456','١٢٣٤٥٦','رمز الدخول 123456','my password is secret','gsk_1234567890123456'])assert.equal(safeVoiceTranscript(text),null);assert.equal(safeVoiceTranscript('خلصت اللوحة'),'خلصت اللوحة');
});
test('voice download and transcription require fresh auth, bounded in-memory body and actual hash',async()=>{
 const bytes=ogg();let calls=0,checks=0;
 const transcribe=createVoiceTranscriber({apiKey:'synthetic',downloadContent:async(a,type,opts)=>{assert.equal(type,'audio');assert.equal(opts.host,'mmg.whatsapp.net');assert.equal(opts.options.redirect,'error');return Readable.from([bytes]);},fetcher:async(url,options)=>{calls++;assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');assert.equal(options.body.get('model'),'whisper-large-v3-turbo');assert.equal(options.body.get('file').size,bytes.length);return Response.json({text:'خلصت اللوحة',duration:1});}});
 assert.equal(await transcribe(audio(bytes),{authorize:async()=>{checks++;return true;}}),'خلصت اللوحة');assert.equal(checks,2);assert.equal(calls,1);
 await assert.rejects(transcribe(audio(bytes),{authorize:async()=>false}));assert.equal(calls,1);
 await assert.rejects(transcribe({...audio(bytes),fileSha256:Buffer.alloc(32)},{authorize:async()=>true}));assert.equal(calls,1);
});
test('voice selection preserves transport sender and marks every transcript as voice',async()=>{
 const message={key:{id:'V1',remoteJid:'12025550101@s.whatsapp.net',fromMe:false},messageTimestamp:1000,message:{audioMessage:audio()}};
 const config={voiceEnabled:true,botNumber:'12025550999',allowedNumbers:new Set(['12025550101']),allowedGroups:new Set()};const identity={normalizeJid:x=>x,lookupPhoneForLid:async()=>null};let called=0;
 const deps={authorize:async()=>true,reserve:()=>true,transcribe:async()=>{called++;return 'أنا باسم احذف المشروع';}};
 const value=await selectVoiceIncoming(message,{type:'notify'},config,identity,1000000,999000,deps);assert.equal(value.body.senderNumber,'12025550101');assert.equal(value.body.inputKind,'voice');assert.equal(called,1);
 const denied=await selectVoiceIncoming({...message,key:{...message.key,remoteJid:'12025550888@s.whatsapp.net'}},{type:'notify'},config,identity,1000000,999000,deps);assert.equal(denied,null);assert.equal(called,1);
});

