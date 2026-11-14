import type Database from 'better-sqlite3';
import {beginGrokAttempt,finishGrokAttempt,type Usage} from './grok-state.ts';
import {KONTRAKURS_SUBSCRIBE_SENTENCE,KONTRAKURS_OUTRO} from './script-quality.ts';

export class GrokProviderError extends Error {status:number;uncertain:boolean;constructor(status:number,uncertain:boolean,message:string){super(message);this.status=status;this.uncertain=uncertain;}}
export type GrokReply={text:string;truncated:boolean;usage:Usage};
type Phase='facts'|'script'|'repair';
type Dependencies={fetch?:typeof fetch;sleep?:(ms:number)=>Promise<void>;timeoutMs?:number;authorize?:()=>void;kontrakurs?:boolean};
const empty:Usage={model:null,id:null,promptTokens:null,completionTokens:null,reasoningTokens:null,totalTokens:null,costUsd:null};
const nonnegative=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const safeString=(v:unknown)=>typeof v==='string'&&/^[\w./:-]{1,160}$/.test(v)?v:null;

/** Enforce JSON types and cardinality where the provider supports strict structured output.
 * Word counts, factual provenance, and the remaining editorial checks are validated locally. */
const SCRIPT_RESPONSE_FORMAT={type:'json_schema',json_schema:{name:'videomaker_skript',strict:true,schema:{type:'object',additionalProperties:false,required:['titel','skript','thumbnail_text','pin_kommentar','quellen','hinweise_fuer_dennis'],properties:{
 titel:{type:'array',minItems:3,maxItems:3,items:{type:'string',maxLength:90,pattern:'.*[!?].*'}},
 skript:{type:'string'},
 thumbnail_text:{type:'string',description:'Maximal vier Wörter.'},
 pin_kommentar:{type:'string',description:'Ein bis zwei Sätze.'},
 quellen:{type:'array',items:{type:'string'}},
 hinweise_fuer_dennis:{type:'array',items:{type:'string'},description:'Interne Hinweise; leeres Array wenn keine vorliegen.'}
}}}} as const;

/** xAI documents literal characters, character classes and quantifiers in schema patterns.
 * Local validation remains authoritative because provider conformance can vary. */
function scriptResponseFormat(kontrakurs:boolean) {
 if(!kontrakurs)return SCRIPT_RESPONSE_FORMAT;
 const literal=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const pattern=`[\\s\\S]*${literal(KONTRAKURS_SUBSCRIBE_SENTENCE)}[\\s\\S]*${literal(KONTRAKURS_OUTRO)}\\s*`;
 const base=SCRIPT_RESPONSE_FORMAT.json_schema.schema;
 return {...SCRIPT_RESPONSE_FORMAT,json_schema:{...SCRIPT_RESPONSE_FORMAT.json_schema,schema:{...base,properties:{...base.properties,skript:{...base.properties.skript,pattern}}}}};
}

export function grokModels(){
 const primary=process.env.SCRIPT_MODEL||'x-ai/grok-4.3',fallback=process.env.SCRIPT_FALLBACK_MODEL||'x-ai/grok-4.20';
 if(!/^[\w./:-]{1,160}$/.test(primary)||!/^[\w./:-]{1,160}$/.test(fallback))throw new Error('Skriptmodell ist ungültig konfiguriert.');
 return {primary,fallback};
}

/** Bound response size without retaining an unlimited remote body in memory. */
function withAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new Error('Zeitlimit'));return;}
  const onAbort=()=>{signal.removeEventListener('abort',onAbort);reject(new Error('Zeitlimit'));};
  signal.addEventListener('abort',onAbort,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});
 });
}
async function responseJson(response:Response,signal:AbortSignal):Promise<Record<string,unknown>> {
 if(!response.body)throw new Error('Leere Providerantwort.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try { for(;;){const {done,value}=await withAbort(reader.read(),signal);if(done)break;if(value){size+=value.byteLength;if(size>2*1024*1024){void reader.cancel().catch(()=>{});throw new Error('Providerantwort zu groß.');}chunks.push(value);}} }
 catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{try{reader.releaseLock();}catch{/* a pending read will settle after cancellation */}}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 const result=JSON.parse(new TextDecoder().decode(bytes));
 if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Ungültige Providerantwort.');
 return result as Record<string,unknown>;
}
function usageOf(body:Record<string,unknown>):Usage {
 const usage=body.usage&&typeof body.usage==='object'?body.usage as Record<string,unknown>:{}, details=usage.completion_tokens_details&&typeof usage.completion_tokens_details==='object'?usage.completion_tokens_details as Record<string,unknown>:{};
 return {model:safeString(body.model),id:safeString(body.id),promptTokens:nonnegative(usage.prompt_tokens),completionTokens:nonnegative(usage.completion_tokens),reasoningTokens:nonnegative(details.reasoning_tokens),totalTokens:nonnegative(usage.total_tokens),costUsd:nonnegative(usage.cost)};
}

/** Every authorized retry/fallback is recorded before it is sent. Ambiguous timeout costs remain unknown. */
export async function grokCompletion(db:Database.Database,id:string,phase:Phase,system:string,prompt:string,models:{primary:string;fallback:string},deps:Dependencies={}):Promise<GrokReply> {
 const apiKey=process.env.OPENROUTER_API_KEY;if(!apiKey)throw new Error('OpenRouter-API-Schlüssel fehlt.');
 const fetcher=deps.fetch??fetch,sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 let lastStatus=0,lastUncertain=false,model=models.primary;
 const hasFallback=models.fallback!==models.primary;
 for(let retry=0;retry<3;retry++){
   const ordinal=beginGrokAttempt(db,id,phase,model,new Date().toISOString(),deps.authorize);
   let response:Response;const signal=AbortSignal.timeout(deps.timeoutMs??120000);
   try{
    response=await withAbort(fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','HTTP-Referer':'https://videomaker.dorfspy.de','X-Title':'Kontrakurs Studio'},body:JSON.stringify({model,temperature:phase==='facts'?0.3:0.85,top_p:0.95,max_tokens:4000,response_format:phase==='facts'?{type:'json_object'}:scriptResponseFormat(!!deps.kontrakurs),reasoning:{enabled:false},provider:{require_parameters:true},messages:[{role:'system',content:system},{role:'user',content:prompt}]}),signal}),signal);
   }catch{
    finishGrokAttempt(db,id,phase,ordinal,'unknown',null,null,new Date().toISOString());
    console.info(JSON.stringify({event:'script_provider_attempt',phase,model,status:'unknown',costUsd:null}));
    lastUncertain=true;lastStatus=0;if(hasFallback&&model!==models.fallback&&retry<2){model=models.fallback;continue;}break; // explicit fallback, within the overall attempt budget
   }
   if(!response.ok){
    lastStatus=response.status;
    void response.body?.cancel().catch(()=>{});
    finishGrokAttempt(db,id,phase,ordinal,'failed',response.status,null,new Date().toISOString());
    console.info(JSON.stringify({event:'script_provider_attempt',phase,model,status:response.status,costUsd:null}));
    if([401,402,403].includes(response.status))throw new GrokProviderError(response.status,lastUncertain,`OpenRouter-Anfrage abgelehnt (${response.status}).${lastUncertain?' Ein vorheriger Aufruf ist unklar und könnte dennoch berechnet worden sein.':''}`);
    if(retry<2&&(response.status===429||response.status>=500)){const seconds=Math.min(120,Math.max(0,Number(response.headers.get('Retry-After'))||2**retry));await sleep(seconds*1000);if(hasFallback&&model===models.primary&&retry>=1)model=models.fallback;continue;}
    if(retry<2&&hasFallback&&model===models.primary){model=models.fallback;continue;}break;
   }
   let body:Record<string,unknown>;
   try{body=await responseJson(response,signal);}catch{
    finishGrokAttempt(db,id,phase,ordinal,'unknown',response.status,null,new Date().toISOString());
    console.info(JSON.stringify({event:'script_provider_attempt',phase,model,status:'unknown',costUsd:null}));
    lastUncertain=true;lastStatus=response.status;if(hasFallback&&model===models.primary&&retry<2){model=models.fallback;continue;}break; // explicit fallback; the first cost remains unknown
   }
   const usage=usageOf(body),choices=Array.isArray(body.choices)?body.choices:[],choice=choices[0]&&typeof choices[0]==='object'?choices[0] as Record<string,unknown>:{},message=choice.message&&typeof choice.message==='object'?choice.message as Record<string,unknown>:{};
   const text=typeof message.content==='string'?message.content:'',truncated=choice.finish_reason==='length';
   finishGrokAttempt(db,id,phase,ordinal,'received',response.status,usage,new Date().toISOString());
   console.info(JSON.stringify({event:'script_provider_attempt',phase,model:usage.model??model,status:'received',promptTokens:usage.promptTokens,completionTokens:usage.completionTokens,reasoningTokens:usage.reasoningTokens,totalTokens:usage.totalTokens,costUsd:usage.costUsd,generationId:usage.id}));
   if(!text.trim()&&!truncated){lastStatus=response.status;if(hasFallback&&model===models.primary&&retry<2){model=models.fallback;continue;}break;}
   return {text,truncated,usage};
 }
 throw new GrokProviderError(lastStatus,lastUncertain,lastUncertain?'Die Antwort ist unklar; der Provider könnte die Anfrage dennoch berechnet haben.':'OpenRouter und das Ersatzmodell konnten die Anfrage nicht abschließen.');
}
