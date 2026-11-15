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
