import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, OpenRouterError, isTransientOpenRouterError, retryAfterSeconds } from '../lib/openrouter.ts';

test('a temporary in-flight budget reservation is retryable and keeps Retry-After',async()=>{
 const previousFetch=globalThis.fetch,previousKey=process.env.OPENROUTER_API_KEY;
 process.env.OPENROUTER_API_KEY='test-key';
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Reservation',metadata:{reason:'in_flight_budget_exhausted'}}}),{status:402,headers:{'Content-Type':'application/json','Retry-After':'120'}});
 try {await assert.rejects(()=>complete('test','test'),error=>error instanceof OpenRouterError && isTransientOpenRouterError(error) && retryAfterSeconds(error)===120);}
 finally {globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previousKey;}
});

test('insufficient credits are not treated as a temporary reservation',()=>{
 assert.equal(isTransientOpenRouterError(new OpenRouterError(402,'insufficient','insufficient_credits')),false);
 assert.equal(isTransientOpenRouterError(new OpenRouterError(503,'unavailable')),true);
 assert.equal(retryAfterSeconds(new OpenRouterError(503,'unavailable','',10000)),120);
});
