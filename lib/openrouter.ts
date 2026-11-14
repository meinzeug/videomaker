export class OpenRouterError extends Error { status:number;reason:string;retryAfter:number;constructor(status:number,message:string,reason='',retryAfter=0){super(message);this.name='OpenRouterError';this.status=status;this.reason=reason;this.retryAfter=retryAfter;} }
export function isTransientOpenRouterError(error:unknown) {return (error instanceof OpenRouterError && ([429,500,502,503,504].includes(error.status) || (error.status===402 && error.reason==='in_flight_budget_exhausted'))) || (error instanceof Error && error.name==='TimeoutError');}
export function retryAfterSeconds(error:unknown) {return error instanceof OpenRouterError && Number.isFinite(error.retryAfter) ? Math.max(0,Math.min(120,error.retryAfter)) : 0;}
class ResearchResultError extends Error {}
class ResearchTruncated extends ResearchResultError {}
function logResearchUsage(result:any,requestedModel:string){
 const u=result?.usage&&typeof result.usage==='object'?result.usage:{},d=u.completion_tokens_details&&typeof u.completion_tokens_details==='object'?u.completion_tokens_details:{};
 const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 const safe=(value:unknown)=>typeof value==='string'&&/^[\w./:-]{1,160}$/.test(value)?value:null;
 console.info(JSON.stringify({event:'research_provider_attempt',requestedModel,model:safe(result?.model),generationId:safe(result?.id),status:'received',promptTokens:num(u.prompt_tokens),completionTokens:num(u.completion_tokens),reasoningTokens:num(d.reasoning_tokens),totalTokens:num(u.total_tokens),costUsd:num(u.cost)}));
}
async function requestCompletion(system: string, prompt: string, maxTokens=10000, tool?: "search" | "fetch" | "deep", preserveTruncated=false, modelOverride?:string) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter-API-Schlüssel fehlt.');
  const response=await fetch('https://openrouter.ai/api/v1/chat/completions', {method:'POST',headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://videomaker.dorfspy.de','X-Title':'Kontrakurs Videomaker'},body:JSON.stringify({model:tool==='deep'?(modelOverride||process.env.RESEARCH_MODEL||process.env.SCRIPT_MODEL||'x-ai/grok-4.3'):(process.env.OPENROUTER_MODEL || 'openai/gpt-6.1-terra'),reasoning:tool==='deep'?{enabled:false}:{effort:'xhigh'},provider:{require_parameters:true},max_tokens:tool==='deep'?4000:maxTokens,...(tool==='deep'?{temperature:0.4,top_p:0.95}:{}),...(tool === 'search' ? {tools:[{type:'openrouter:web_search',parameters:{engine:'exa',max_results:5,max_total_results:20}}],max_tool_calls:6} : tool === 'fetch' ? {tools:[{type:'openrouter:web_fetch',parameters:{engine:'openrouter',max_content_tokens:12000}}],max_tool_calls:4} : tool === 'deep' ? {tools:[{type:'openrouter:web_search',parameters:{engine:'exa',max_results:5,max_total_results:30}},{type:'openrouter:web_fetch',parameters:{engine:'openrouter',max_content_tokens:16000}}],max_tool_calls:8} : {}),messages:[{role:'system',content:system},{role:'user',content:prompt}]}),signal:AbortSignal.timeout(tool==='deep'?120000:240000)});
  const result=await response.json().catch(()=>({}));
  if (!response.ok) throw new OpenRouterError(response.status, `OpenRouter (${response.status}): ${String(result?.error?.message || 'Anfrage fehlgeschlagen').slice(0,400)}`,String(result?.error?.metadata?.reason || ''),Number(response.headers.get('Retry-After') || result?.error?.metadata?.headers?.['Retry-After'] || 0));
  if(tool==='deep')logResearchUsage(result,modelOverride||process.env.RESEARCH_MODEL||process.env.SCRIPT_MODEL||'x-ai/grok-4.3');
  const counts=[result.usage?.server_tool_use_details?.web_search_requests,result.usage?.server_tool_use?.web_search_requests].filter((x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0);
  const searchRequests=counts.length?Math.min(...counts):0;
  if (tool === 'deep' && searchRequests<2) throw new ResearchResultError('Die vertiefte Recherche konnte nicht ausreichend im Web suchen. Bitte erneut versuchen.');
  if (tool === 'search' && searchRequests<1) throw new Error('Die Websuche wurde nicht ausgeführt. Bitte erneut versuchen.');
  const choice=result.choices?.[0];
  if (choice?.finish_reason==='length'&&!preserveTruncated) {if(tool==='deep')throw new ResearchTruncated('Die Rechercheantwort wurde am Tokenlimit abgeschnitten.');throw new Error('Die KI-Antwort wurde abgeschnitten. Bitte erneut versuchen.');}
  if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw tool==='deep'?new ResearchResultError('OpenRouter lieferte keine Textantwort.'):new Error('OpenRouter lieferte keine Textantwort.');
  const annotations=Array.isArray(choice.message.annotations)?choice.message.annotations:[];
  const citationUrls=annotations.flatMap((a:{type?:string;url_citation?:{url?:unknown}})=>a.type==='url_citation'&&typeof a.url_citation?.url==='string'?[a.url_citation.url]:[]);
  return {text:choice.message.content as string,citationUrls,searchRequests,truncated:choice?.finish_reason==='length',usage:result.usage,model:typeof result.model==='string'?result.model:null,generationId:typeof result.id==='string'?result.id:null};
}
export async function complete(system:string,prompt:string,maxTokens=10000,tool?:"search"|"fetch"|"deep") {return (await requestCompletion(system,prompt,maxTokens,tool)).text;}
/** Retain a partial script response instead of discarding it before persistence. */
export async function completeForGeneration(system:string,prompt:string,maxTokens=32000) {return requestCompletion(system,prompt,maxTokens,undefined,true);}
/** Research uses Grok separately. Retries are explicitly authorized; an interrupted attempt may still be billed. */
export async function deepComplete(system:string,prompt:string,maxTokens=4000,authorize?:()=>void) {
 const primary=process.env.RESEARCH_MODEL||process.env.SCRIPT_MODEL||'x-ai/grok-4.3',fallback=process.env.SCRIPT_FALLBACK_MODEL||'x-ai/grok-4.20';
 if(!/^[\w./:-]{1,160}$/.test(primary)||!/^[\w./:-]{1,160}$/.test(fallback))throw new Error('Recherchemodell ist ungültig konfiguriert.');
 let last:unknown,model=primary;
 const hasFallback=primary!==fallback;
 for(let retry=0;retry<3;retry++){
  authorize?.();
  try{return await requestCompletion(system,prompt,maxTokens,'deep',false,model);}
  catch(error){
   last=error;
   const status=error instanceof OpenRouterError?error.status:null;
   if(!(error instanceof ResearchResultError))console.info(JSON.stringify({event:'research_provider_attempt',requestedModel:model,status:status??'unknown',costUsd:null}));
   if(status!==null&&[401,402,403].includes(status))throw error;
   if(retry<2&&status!==null&&(status===429||status>=500)){
    const seconds=Math.min(120,Math.max(0,retryAfterSeconds(error)||2**retry));await new Promise(resolve=>setTimeout(resolve,seconds*1000));
    if(hasFallback&&model===primary&&retry>=1)model=fallback;
    continue;
   }
   if(retry<2&&hasFallback&&model===primary){model=fallback;continue;}
   break;
  }
 }
 throw last instanceof Error?last:new Error('Recherche nicht verfügbar.');
}
export function parseJson(text:string) { const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); return JSON.parse(cleaned); }
