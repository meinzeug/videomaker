/** Browser-only notification; a late response from before a new login cannot expire it. */
let sessionGeneration=0;
const staleResponses=new WeakSet<Response>();
export function isStaleSessionResponse(response:Response){return staleResponses.has(response);}
export const sessionExpiredEvent='videomaker-session-expired';
export function sessionRenewed(){sessionGeneration++;}
export async function sessionFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const generation=sessionGeneration;
 const response=await fetch(input,init);
 if(response.status===401){
  if(generation!==sessionGeneration)staleResponses.add(response);
  else if(!init?.signal?.aborted&&typeof window!=='undefined')window.dispatchEvent(new Event(sessionExpiredEvent));
 }
 return response;
}

export class ApiError extends Error {
 constructor(public status:number,message:string,public retryAfter=0,public researchRetained=false){super(message);}
}
/** Classify failed HTTP status even if its body is empty, malformed, or interrupted. */
export async function apiResponseJson(response:Response){
 if(response.ok)return response.json();
 const data=await response.json().catch(()=>null);
 const message=isStaleSessionResponse(response)?'Die Anfrage gehörte zur früheren Anmeldung. Bitte prüfe den Status; es wird nichts automatisch wiederholt.':typeof data?.error==='string'?data.error:'Anfrage fehlgeschlagen.';
 throw new ApiError(response.status,message,Number(response.headers.get('Retry-After')||0),data?.researchRetained===true);
}

/** A submitted web-research request can have reached a paid provider before auth was revoked. */
export function researchMayHaveRun(status:number,scope:string){return status===401&&scope==='web';}
