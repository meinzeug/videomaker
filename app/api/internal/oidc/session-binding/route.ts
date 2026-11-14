import Database from 'better-sqlite3';
import { join } from 'node:path';
import { sessionBindingProof } from '@/lib/auth';
import { internalSessionSecretConfigured, internalSessionSecretValid } from '@/lib/buchhaltung-session';
import { createOidcSessionBindings } from '@/lib/oidc-session-bindings';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const state=globalThis as typeof globalThis & {__videomakerOidcBindingActive?:number};

function cookieValue(request:Request):string|null {
 const values=(request.headers.get('cookie')||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith('kontrakurs_session='));
 if(values.length!==1||!/^kontrakurs_session=[A-Za-z0-9_.-]{1,512}$/.test(values[0]))return null;
 return values[0].slice('kontrakurs_session='.length);
}

/** Internal-only service interface; never enable until the TLS endpoint and private secret are provisioned. */
export async function POST(request:Request) {
 if(process.env.OIDC_BINDING_ENABLED!=='true')return new Response(null,{status:404,headers});
 const secret=process.env.OIDC_BINDING_INTERNAL_SECRET;
 if(!internalSessionSecretConfigured(secret))return new Response(null,{status:503,headers});
 if(!internalSessionSecretValid(secret,request.headers.get('x-videomaker-internal-secret')))return new Response(null,{status:401,headers});
 const operation=request.headers.get('x-oidc-binding-operation');
 // The internal protocol is header-only; explicitly require a zero-length body.
 if((operation!=='issue'&&operation!=='check'&&operation!=='reset')||request.headers.get('content-length')!=='0'||request.headers.has('transfer-encoding'))return new Response(null,{status:400,headers});
 if((state.__videomakerOidcBindingActive??0)>=16)return new Response(null,{status:503,headers});
 state.__videomakerOidcBindingActive=(state.__videomakerOidcBindingActive??0)+1;
 let database:Database.Database|undefined;
 try {
  database=new Database(join(process.env.DATA_DIR||'./data','videomaker.sqlite'),{fileMustExist:true,timeout:1000});
  const bindings=createOidcSessionBindings(database,sessionBindingProof);
  if(operation==='issue'||operation==='reset') {
   const cookie=cookieValue(request);
   if(!cookie)return new Response(null,{status:401,headers});
   if(operation==='reset')return new Response(null,{status:bindings.resetForCookie(cookie)?204:401,headers});
   const reference=bindings.issue(cookie);
   return reference?Response.json({reference},{status:200,headers}):new Response(null,{status:401,headers});
  }
  const reference=request.headers.get('x-oidc-session-reference')||'';
  return new Response(null,{status:bindings.isActive(reference)?204:401,headers});
 } catch {
  return new Response(null,{status:503,headers});
 } finally {
  database?.close();
  state.__videomakerOidcBindingActive!--;
 }
}
