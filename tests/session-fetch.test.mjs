import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFetch,sessionRenewed,sessionExpiredEvent} from '../app/session-fetch.ts';

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
  assert.equal((await stale).status,401);assert.equal(notifications,1);assert.equal(calls,3);
 }finally{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;}
});
