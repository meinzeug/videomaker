import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {drainDeletedRecording} from '../lib/recording-deleted-drain.ts';

const chunk=(...parts)=>new ReadableStream({start(c){for(const part of parts)c.enqueue(new Uint8Array(part));c.close();}}).getReader();
const drain=(reader,length,max=100,check=()=>{},auth=()=>true,opts={idleMs:100,totalMs:300,pollMs:5})=>drainDeletedRecording(reader,length,max,check,auth,opts);

test('complete, missing and oversized bodies are distinguished',async()=>{
 assert.equal(await drain(chunk(3,4),7),'complete');
 assert.equal(await drain(chunk(3),7),'incomplete');
 assert.equal(await drain(chunk(6,6),7),'too_large');
 assert.equal(await drain(chunk(6,6),0,10),'too_large');
 assert.equal(await drain(chunk(),0),'incomplete');
});
test('session revocation while read is stalled is detected and cancel is not awaited',async()=>{
 let permitted=true,cancelled=false;
 const reader=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}).getReader();
 setTimeout(()=>{permitted=false;},15);
 assert.equal(await drain(reader,4,100,()=>{},()=>permitted),'unauthorized');assert.equal(cancelled,true);
});
test('session revoked before the final chunk never produces complete',async()=>{
 let permitted=true;
 const reader={async read(){permitted=false;return {done:false,value:new Uint8Array(4)};},async cancel(){}};
 assert.equal(await drain(reader,4,100,()=>{},()=>permitted),'unauthorized');
});
test('slow and continuous trickle both have finite deadlines',async()=>{
 let cancelled=false;
 const stalled=new ReadableStream({cancel(){cancelled=true;}}).getReader();
 assert.equal(await drain(stalled,4,100,()=>{},()=>true,{idleMs:20,totalMs:200,pollMs:3}),'timeout');assert.equal(cancelled,true);
 let interval;const trickle=new ReadableStream({start(c){interval=setInterval(()=>c.enqueue(new Uint8Array(1)),4);},cancel(){clearInterval(interval);}}).getReader();
 assert.equal(await drain(trickle,0,10000,()=>{},()=>true,{idleMs:30,totalMs:50,pollMs:3}),'timeout');
});
test('lost lease aborts without reporting deleted',async()=>{
 let n=0;const reader=new ReadableStream({}).getReader();
 await assert.rejects(()=>drain(reader,4,100,()=>{if(++n>1)throw Error('UPLOAD_LEASE_LOST');}),/UPLOAD_LEASE_LOST/);
});
test('4.8 MB streaming HTTP body is sent completely before receiving 409', {timeout:15000},async()=>{
 const server=createServer(async(req,res)=>{
  try{
   const outcome=await drainDeletedRecording(Readable.toWeb(req).getReader(),Number(req.headers['content-length']),1024*1024*1024,()=>{},()=>true);
   res.writeHead(outcome==='complete'?409:400,{'content-type':'application/json'});res.end(JSON.stringify({code:outcome==='complete'?'recording_deleted':outcome}));
  }catch{res.writeHead(500);res.end();}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const size=4_800_000,body=Buffer.alloc(16_000,0x35);
  const response=await new Promise((resolve,reject)=>{
   const req=request({host:'127.0.0.1',port:server.address().port,method:'POST',headers:{'content-length':size}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
   });
   req.on('error',reject);
   (async()=>{try{for(let sent=0;sent<size;sent+=body.length){if(!req.write(body.subarray(0,Math.min(body.length,size-sent))))await once(req,'drain');}req.end();}catch(error){reject(error);}})();
  });
  assert.deepEqual(response,{status:409,body:{code:'recording_deleted'}});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
