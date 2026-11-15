/** Browser-only notification; a late response from before a new login cannot expire it. */
let sessionGeneration=0;
export const sessionExpiredEvent='videomaker-session-expired';
export function sessionRenewed(){sessionGeneration++;}
export async function sessionFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const generation=sessionGeneration;
 const response=await fetch(input,init);
 if(response.status===401&&generation===sessionGeneration&&typeof window!=='undefined')window.dispatchEvent(new Event(sessionExpiredEvent));
 return response;
}
