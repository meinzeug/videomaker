import test from 'node:test';
import assert from 'node:assert/strict';
import {readLiveRecordingBody} from '../lib/live-recording-body.ts';

test('valid body is returned unchanged, while a truncated body fails',async()=>{
 const stream=items=>new ReadableStream({start(controller){for(const item of items)controller.enqueue(Buffer.from(item));controller.close();}}).getReader();
 assert.equal((await readLiveRecordingBody(stream(['abc','de']),5,()=>{})).toString(),'abcde');
 await assert.rejects(readLiveRecordingBody(stream(['abc']),5,()=>{}),{code:'INCOMPLETE'});
});
test('oversize body rejects immediately even when cancellation never resolves',async()=>{
 let cancelled=false;
 const reader={read:async()=>({done:false,value:Buffer.from('too long')}),cancel:()=>{cancelled=true;return new Promise(()=>{});}};
 const outcome=await Promise.race([readLiveRecordingBody(reader,1,()=>{}).catch(error=>error.code),new Promise(resolve=>setTimeout(()=>resolve('HUNG'),200))]);
 assert.equal(outcome,'TOO_LARGE');assert.equal(cancelled,true);
});
test('drip feed cannot extend the total deadline by repeatedly delivering bytes',async()=>{
 let time=0,cancelled=false;
 const reader={read:async()=>{time+=40;return {done:false,value:Buffer.from('x')};},cancel:()=>{cancelled=true;return new Promise(()=>{});}};
 await assert.rejects(readLiveRecordingBody(reader,10,()=>{},()=>time,100),{code:'TIMEOUT'});
 assert.equal(cancelled,true);
});
