import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFetch,sessionRenewed,sessionExpiredEvent,isStaleSessionResponse,ApiError,apiResponseJson,researchMayHaveRun} from '../app/session-fetch.ts';

test('only current 401 reports expiration; stale responses and 403 never trigger it or retry', async()=>{
 const originalFetch=globalThis.fetch,originalWindow=globalThis.window;
 const win=new EventTarget();globalThis.window=win;let notifications=0,calls=0;win.addEventListener(sessionExpiredEvent,()=>notifications++);
 try{
  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:403});};
  assert.equal((await sessionFetch('/api/research')).status,403);assert.equal(notifications,0);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:401});};
  assert.equal((await sessionFetch('/api/research',{method:'POST'})).status,401);assert.equal(notifications,1);assert.equal(calls,2);
  let finish;globalThis.fetch=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const stale=sessionFetch('/api/research',{method:'POST'});sessionRenewed();finish(new Response('{}',{status:401}));
  const staleResponse=await stale;assert.equal(staleResponse.status,401);assert.equal(isStaleSessionResponse(staleResponse),true);assert.equal(notifications,1);assert.equal(calls,3);
  const aborted=new AbortController();aborted.abort();globalThis.fetch=async()=>{calls++;return new Response('{}',{status:401});};await sessionFetch('/api/generate',{signal:aborted.signal});assert.equal(notifications,1);assert.equal(calls,4);
 }finally{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;}
});

test('empty or damaged 401 retains its HTTP identity, not a generic JSON error',async()=>{
 for(const body of ['', '{bad json']){
  await assert.rejects(apiResponseJson(new Response(body,{status:401})),error=>error instanceof ApiError&&error.status===401);
 }
 await assert.rejects(apiResponseJson(new Response('',{status:403})),error=>error instanceof ApiError&&error.status===403);
});
test('unconfirmed web research after 401 requires an explicit decision',()=>{
 assert.equal(researchMayHaveRun(401,'web'),true);
 assert.equal(researchMayHaveRun(401,'selected'),false);
 assert.equal(researchMayHaveRun(403,'web'),false);
});
