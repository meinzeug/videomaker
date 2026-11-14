import { createHmac, createPrivateKey } from 'node:crypto';
import { Provider } from 'oidc-provider';
import { createOidcStorageAdapter } from './oidc-storage.ts';
import { createOidcProviderSessionMap } from './oidc-provider-session-map.ts';

const cookiePattern=/^kontrakurs_session=[A-Za-z0-9_.-]{1,512}$/;
const safeName=/^[A-Za-z0-9_-]{1,128}$/;
const providerCookieNames=new Set(['vm_oidc_session','vm_oidc_session.sig']);

/** Refuse malformed or duplicate browser session cookies. */
function browserCookie(header) {
 const all=typeof header==='string'?header.split(';').map(part=>part.trim()).filter(part=>part.startsWith('kontrakurs_session=')):[];
 return all.length===1&&cookiePattern.test(all[0])?all[0]:null;
}

/** Every new authorization starts a new provider session; existing token sessions remain valid. */
function clearProviderSession(header) {
 return (header||'').split(';').map(part=>part.trim()).filter(part=>part&&!providerCookieNames.has(part.split('=')[0])).join('; ');
}

function checkedUrl(value,allowLoopback) {
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash||url.href.endsWith('/'))throw new Error('Ungültige OIDC-Adresse');
 if(url.protocol!=='https:'&&!(allowLoopback&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw new Error('OIDC verlangt HTTPS');
 return url;
}

/** Explicit configuration only; no generated keys, implicit client, local password or public listener. */
export function validateVideomakerOidcConfig(config,{allowLoopback=false}={}) {
 const issuer=checkedUrl(config.issuer,allowLoopback),redirect=checkedUrl(config.redirect,allowLoopback);
 if(!allowLoopback&&(issuer.pathname!=='/oidc'||redirect.origin!==issuer.origin||redirect.pathname!=='/buchhaltung/api/auth/callback/oidc'))throw new Error('OIDC-Issuer oder Haben-Callback stimmt nicht');
 if(typeof config.clientId!=='string'||!safeName.test(config.clientId)||typeof config.subject!=='string'||!safeName.test(config.subject)||typeof config.email!=='string'||!/^[^\s@]+@[^\s@]+$/.test(config.email))throw new Error('OIDC-Identität oder Client ungültig');
 if(typeof config.clientSecret!=='string'||!/^[\x21-\x7e]{32,256}$/.test(config.clientSecret)||typeof config.cacheKey!=='string'||!/^[\x21-\x7e]{32,256}$/.test(config.cacheKey))throw new Error('OIDC-Geheimnis fehlt');
 if(!Array.isArray(config.cookieKeys)||!config.cookieKeys.length||config.cookieKeys.some(key=>typeof key!=='string'||!/^[\x21-\x7e]{32,256}$/.test(key)))throw new Error('OIDC-Cookieschlüssel fehlt');
 if(!config.jwks||!Array.isArray(config.jwks.keys)||config.jwks.keys.length!==1)throw new Error('Genau ein privater OIDC-Signaturschlüssel erforderlich');
 const jwk=config.jwks.keys[0];
 if(jwk?.kty!=='RSA'||jwk.alg!=='RS256'||jwk.use!=='sig'||typeof jwk.kid!=='string'||!safeName.test(jwk.kid)||!jwk.d)throw new Error('Ungültiger OIDC-Signaturschlüssel');
 let privateKey;try{privateKey=createPrivateKey({key:jwk,format:'jwk'});}catch{throw new Error('Ungültiger OIDC-Signaturschlüssel');}
 if(privateKey.asymmetricKeyType!=='rsa'||(privateKey.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error('OIDC-Signaturschlüssel zu kurz');
 return { ...config, issuer:issuer.href, redirect:redirect.href };
}

/**
 * A single configured admin and one confidential Haben client. The binding
 * client must provide issue/check/match and validates sessions on every use.
 */
export function createVideomakerOidcService(config,{db,binding,allowLoopback=false,clock=Date.now}={}) {
 const c=validateVideomakerOidcConfig(config,{allowLoopback});
 if(!db||!binding||['issue','check','match'].some(name=>typeof binding[name]!=='function'))throw new Error('OIDC-Sitzungsspeicher nicht verfügbar');
 const map=createOidcProviderSessionMap(db),cache=new Map(),pendingLogins=new Map();
 const keyFor=cookie=>createHmac('sha256',c.cacheKey).update('videomaker-oidc-browser/v1\0').update(cookie).digest('hex');
 async function referenceFor(cookie) {
  if(!cookie)return null;
  const now=clock();if(!Number.isSafeInteger(now)||now<0)throw new Error('Ungültige OIDC-Zeit');
  for(const [key,value] of cache)if(value.expires<=now)cache.delete(key);
  const key=keyFor(cookie),entry=cache.get(key);
  if(entry){if(await binding.match(entry.reference,cookie))return entry.reference;cache.delete(key);}
  if(cache.size>=1024)throw new Error('OIDC-Sitzungscache ausgelastet');
  const reference=await binding.issue(cookie);if(!reference)return null;
  cache.set(key,{reference,expires:now+120000});return reference;
 }
 const provider=new Provider(c.issuer,{
  adapter:createOidcStorageAdapter(db),jwks:c.jwks,
  cookies:{keys:c.cookieKeys,names:{session:'vm_oidc_session',interaction:'vm_oidc_interaction',resume:'vm_oidc_resume'}},
  clients:[{client_id:c.clientId,client_secret:c.clientSecret,redirect_uris:[c.redirect],response_types:['code'],grant_types:['authorization_code'],token_endpoint_auth_method:'client_secret_basic'}],
  features:{devInteractions:{enabled:false},registration:{enabled:false},deviceFlow:{enabled:false},ciba:{enabled:false},revocation:{enabled:false},introspection:{enabled:false}},
  ttl:{Interaction:300,Session:43200,Grant:43200,AuthorizationCode:120,AccessToken:300,IdToken:300},
  renderError:async(ctx)=>{ctx.type='text/plain';ctx.set('Cache-Control','no-store');ctx.body='Die Anmeldung ist nicht möglich.';},
  interactions:{url:(_ctx,interaction)=>`${c.issuer}/interaction/${interaction.uid}`},
  claims:{openid:['sub','videomaker_session_ref'],profile:['name'],email:['email','email_verified'],groups:['groups']},
  scopes:['openid','profile','email','groups'],pkce:{required:()=>true,methods:['S256']},
  findAccount:async(ctx,accountId,source)=>{
   if(accountId!==c.subject)return undefined;
   let reference;
   if(source){reference=map.find(source.sessionUid);if(!reference||!await binding.check(reference))return undefined;}
   else {
    if(!ctx.req.url?.startsWith('/auth'))return undefined;
    reference=await referenceFor(browserCookie(ctx.req.headers.cookie));if(!reference)return undefined;
   }
   return {accountId,claims:async()=>({sub:accountId,name:c.email,email:c.email,email_verified:false,groups:['haben-inhaber'],videomaker_session_ref:reference})};
  },
 });
 provider.proxy=c.issuer.startsWith('https:');
 async function handle(req,res) {
  try {
   const mount=new URL(c.issuer).pathname.replace(/\/$/,'');
   if(mount&&((req.url||'').startsWith(`${mount}/`)||(req.url||'').startsWith(`${mount}?`)||req.url===mount))req.url=req.url.slice(mount.length)||'/';
   if(mount)req.originalUrl=`${mount}${req.url||'/'}`;
   const pathname=new URL(req.url||'/', 'http://127.0.0.1').pathname;
   const initialAuthorization=req.method==='GET'&&pathname==='/auth';
   if(initialAuthorization)req.headers.cookie=clearProviderSession(req.headers.cookie);
   if(pathname==='/auth'||pathname.startsWith('/auth/')||pathname.startsWith('/interaction/')) {
    if(req.method!=='GET'){res.writeHead(405,{'cache-control':'no-store'}).end();return;}
    const cookie=browserCookie(req.headers.cookie),reference=await referenceFor(cookie);
    if(!reference){res.writeHead(401,{'cache-control':'no-store'}).end();return;}
    if(initialAuthorization){
     const secure=c.issuer.startsWith('https:')?'; Secure':'';
     res.setHeader('Set-Cookie',Array.from(providerCookieNames,name=>`${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`));
    }
    if(pathname.startsWith('/interaction/')) {
     const interaction=await provider.interactionDetails(req,res);
     if(interaction.params.client_id!==c.clientId||typeof interaction.cid!=='string'){res.writeHead(401,{'cache-control':'no-store'}).end();return;}
     let result;
     if(interaction.prompt.name==='login'){
      // Initial /auth strips older provider sessions. A login proof is tied to
      // this provider interaction and the already-verified Videomaker session.
      for(const [id,pending] of pendingLogins)if(pending.expires<=clock())pendingLogins.delete(id);
      const previous=pendingLogins.get(interaction.cid);
      if(interaction.session?.uid||(previous&&previous.reference!==reference)||(!previous&&pendingLogins.size>=1024)){res.writeHead(401,{'cache-control':'no-store'}).end();return;}
      pendingLogins.set(interaction.cid,{reference,expires:clock()+120000});
      result={login:{accountId:c.subject}};
     }
     else if(interaction.prompt.name==='consent'){
      const pending=pendingLogins.get(interaction.cid),uid=interaction.session?.uid;
      if(!pending||pending.expires<=clock()||!uid||interaction.session.accountId!==c.subject||!(await binding.match(pending.reference,cookie))){res.writeHead(401,{'cache-control':'no-store'}).end();return;}
      const existing=map.find(uid);
      if(existing&&existing!==pending.reference){res.writeHead(401,{'cache-control':'no-store'}).end();return;}
      if(!existing)map.bindOnce(uid,pending.reference);
      pendingLogins.delete(interaction.cid);
      const grant=new provider.Grant({accountId:c.subject,clientId:c.clientId});grant.addOIDCScope('openid profile email groups');
      result={consent:{grantId:await grant.save()}};
     }else{res.writeHead(403,{'cache-control':'no-store'}).end();return;}
     await provider.interactionFinished(req,res,result,{mergeWithLastSubmission:false});return;
    }
   }
   await provider.callback()(req,res);
  }catch{if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});if(!res.writableEnded)res.end();}
 }
 return {handle};
}
