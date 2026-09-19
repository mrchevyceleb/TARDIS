import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDictationRouter } from './dictation.ts';

test('dictation requires same-origin audio and reuses a successful section without repeating transcription',async()=>{
 let calls=0,cleanups=0,busy=true;
 const app=express();app.use('/api/dictation',createDictationRouter(async()=>{
  calls++;if(busy)throw Object.assign(new Error('Another recording is being transcribed.'),{status:409});return {text:'um keep all three ideas'};
 },async text=>{cleanups++;assert.equal(text,'um keep all three ideas');return {text:'Keep all three ideas.'};}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const wav=Buffer.alloc(64);wav.write('RIFF');wav.write('WAVE',8);
 const headers={'content-type':'application/octet-stream',origin:base,'sec-fetch-site':'same-origin','x-dictation-chunk':'11111111-1111-4111-a111-111111111111:0'};
 const send=(body=wav,extra={})=>fetch(base+'/api/dictation/chunks',{method:'POST',headers:{...headers,...extra},body});
 try{
  assert.equal((await send(wav,{origin:'https://untrusted.invalid'})).status,403);assert.equal(calls,0);
  assert.equal((await send(Buffer.alloc(64))).status,415);assert.equal(calls,0);
  assert.equal((await send()).status,409);busy=false;
  assert.deepEqual(await (await send()).json(),{text:'Keep all three ideas.'});assert.equal(calls,2);
  assert.deepEqual(await (await send()).json(),{text:'Keep all three ideas.'});assert.equal(calls,2);assert.equal(cleanups,1);
  const changed=Buffer.from(wav);changed[50]=1;assert.equal((await send(changed)).status,409);assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
