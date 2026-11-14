/**
 * A fixed external origin is the only trust anchor in configured mode.  Next
 * can construct req.url from client-supplied X-Forwarded-* headers, so neither
 * that URL nor forwarding headers establish the public origin.
 */
function parseOrigin(raw:string):URL|null {
 if(!/^https?:\/\/[^\s\\/?#@]+$/i.test(raw)||raw.endsWith(':'))return null;
 try {
  const url=new URL(raw);
  if((url.protocol!=='https:'&&url.protocol!=='http:')||!url.hostname||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
  return url;
 } catch {return null;}
}

/** The value is a single serialized origin, not a URL path, comma-list or wildcard. */
export function configuredSameOrigin(origin:string|null,host:string|null,configured:string):boolean {
 const expected=parseOrigin(configured),actual=origin===null?null:parseOrigin(origin);
 if(!expected||!actual||!host||host.endsWith(':')||/[\s\\/?#@,]/.test(host))return false;
 let destination:URL;
 try {destination=new URL(`${expected.protocol}//${host}`);} catch {return false;}
 if(destination.username||destination.password||destination.pathname!=='/'||destination.search||destination.hash)return false;
 return actual.origin===expected.origin&&destination.host===expected.host;
}

/**
 * Preserve existing installations until an operator configures a public
 * origin. An explicitly configured invalid/empty origin fails closed.
 */
export function sameOriginPolicy(origin:string|null,host:string|null,forwardedHost:string|null,configured:string|undefined):boolean {
 if(configured!==undefined)return configuredSameOrigin(origin,host,configured);
 const legacyHost=forwardedHost||host;
 if(!origin||!legacyHost)return false;
 try{return new URL(origin).host===legacyHost;}catch{return false;}
}
