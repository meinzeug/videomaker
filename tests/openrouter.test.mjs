import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete,deepComplete, OpenRouterError, isTransientOpenRouterError, retryAfterSeconds } from '../lib/openrouter.ts';

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

test('only deep research uses configured Grok model, temperature 0.4 and 4000 tokens',async()=>{
 const previousFetch=globalThis.fetch,previousKey=process.env.OPENROUTER_API_KEY,oldResearch=process.env.RESEARCH_MODEL,oldScript=process.env.SCRIPT_MODEL,calls=[];
 process.env.OPENROUTER_API_KEY='test-key';
 globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response(JSON.stringify({usage:{server_tool_use_details:{web_search_requests:2}},choices:[{finish_reason:'stop',message:{content:'ok'}}]}),{status:200});};
 try{delete process.env.RESEARCH_MODEL;delete process.env.SCRIPT_MODEL;await deepComplete('test','research');await complete('test','other');process.env.SCRIPT_MODEL='test/script';await deepComplete('test','research');process.env.RESEARCH_MODEL='test/research';await deepComplete('test','research');assert.equal(calls[0].model,'x-ai/grok-4.3');assert.equal(calls[0].temperature,0.4);assert.equal(calls[0].top_p,0.95);assert.equal(calls[0].max_tokens,4000);assert.deepEqual(calls[0].reasoning,{enabled:false});assert.equal(Object.hasOwn(calls[1],'temperature'),false);assert.equal(calls[2].model,'test/script');assert.equal(calls[3].model,'test/research');}
 finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previousKey;if(oldResearch===undefined)delete process.env.RESEARCH_MODEL;else process.env.RESEARCH_MODEL=oldResearch;if(oldScript===undefined)delete process.env.SCRIPT_MODEL;else process.env.SCRIPT_MODEL=oldScript;}
});

test('deep research accepts either documented search usage shape and never invents tool use',async()=>{
 const previousFetch=globalThis.fetch,previousKey=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-key';
 let usage={server_tool_use:{web_search_requests:2}};
 globalThis.fetch=async()=>new Response(JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content:'ok'}}]}),{status:200});
 try{
  assert.equal((await deepComplete('test','research')).searchRequests,2);
  usage={server_tool_use_details:{web_search_requests:2}};assert.equal((await deepComplete('test','research')).searchRequests,2);
  usage={server_tool_use:{web_search_requests:2},server_tool_use_details:{web_search_requests:1}};
  await assert.rejects(()=>deepComplete('test','research'),/nicht ausreichend/);
 }finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previousKey;}
});

test('deep research exhausts a single global 503 retry budget including fallback',async()=>{
 const previousFetch=globalThis.fetch,previousKey=process.env.OPENROUTER_API_KEY,oldResearch=process.env.RESEARCH_MODEL,oldScript=process.env.SCRIPT_MODEL,oldFallback=process.env.SCRIPT_FALLBACK_MODEL;process.env.OPENROUTER_API_KEY='test-key';delete process.env.RESEARCH_MODEL;delete process.env.SCRIPT_MODEL;delete process.env.SCRIPT_FALLBACK_MODEL;
 const models=[];globalThis.fetch=async(_url,init)=>{models.push(JSON.parse(init.body).model);return new Response('{}',{status:503});};
 try{await assert.rejects(deepComplete('test','research'),/503/);assert.deepEqual(models,['x-ai/grok-4.3','x-ai/grok-4.3','x-ai/grok-4.20']);}
 finally{globalThis.fetch=previousFetch;for(const [key,value] of Object.entries({OPENROUTER_API_KEY:previousKey,RESEARCH_MODEL:oldResearch,SCRIPT_MODEL:oldScript,SCRIPT_FALLBACK_MODEL:oldFallback}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
