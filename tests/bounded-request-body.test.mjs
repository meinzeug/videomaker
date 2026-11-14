import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedBodyError,readBoundedRequestBody} from '../lib/bounded-request-body.ts';

test('überlanger Body wird abgewiesen ohne auf nicht endendes cancel zu warten',async()=>{
 const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1025));},cancel(){return new Promise(()=>{});}});
 await assert.rejects(Promise.race([
  readBoundedRequestBody(stream),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('cancel blockiert')),500);timer.unref();}),
 ]),error=>error instanceof BoundedBodyError&&error.code==='TOO_LARGE');
});
test('langsame Einzelteile verlängern die monotone Gesamtfrist nicht',async()=>{
 let interval;
 const stream=new ReadableStream({start(controller){interval=setInterval(()=>controller.enqueue(new Uint8Array([32])),5);},cancel(){clearInterval(interval);}});
 const start=performance.now();
 try{await assert.rejects(readBoundedRequestBody(stream,1024,60));assert.ok(performance.now()-start<500);}
 finally{clearInterval(interval);}
});
test('kleine Daten dürfen in mehreren Teilen erfolgreich gelesen werden',async()=>{
 const stream=new ReadableStream({start(controller){controller.enqueue(Buffer.from('abc'));controller.enqueue(Buffer.from('def'));controller.close();}});
 assert.equal((await readBoundedRequestBody(stream)).toString(),'abcdef');
});
