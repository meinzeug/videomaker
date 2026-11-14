// TEST ONLY: real Haben callback and actual Videomaker OIDC service, disposable PostgreSQL.
import {test,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {createVideomakerOidcService} from '../../lib/videomaker-oidc-service.mjs';
import {initializeOidcStorage} from '../../lib/oidc-storage.ts';
import {initializeOidcProviderSessionMap} from '../../lib/oidc-provider-session-map.ts';
import {createOidcSessionBindings,initializeOidcSessionBindings} from '../../lib/oidc-session-bindings.ts';
import {verifiedSessionBindingProof} from '../../lib/session-binding-proof.ts';
import {sessionRevoked,revokeSession} from '../../lib/session-revocations.ts';
import {signSessionBody} from '../../lib/session-cookie.ts';
import {setupTestDb} from '../../apps/buchhaltung/apps/web/src/server/test-db.ts';

test('actual Videomaker OIDC service signs in to the real Haben callback and enforces logout',async()=>{
 const vmDb=new Database(':memory:'),providerDb=new Database(':memory:');
 const vmSecret='synthetischer-videomaker-testschluessel-123456789';
 initializeOidcStorage(providerDb);initializeOidcProviderSessionMap(providerDb);
 sessionRevoked(vmDb,vmSecret,'testinitialisierung');initializeOidcSessionBindings(vmDb);
 const bindings=createOidcSessionBindings(vmDb,(db,value)=>verifiedSessionBindingProof(db,value,vmSecret),Date.now,()=>vmSecret);
 const raw=cookie=>cookie.startsWith('kontrakurs_session=')?cookie.slice('kontrakurs_session='.length):'';
 // This fixture exercises the real binding implementation in-process. TLS/proxy and browser remain separate tests.
 const binding={issue:async cookie=>bindings.issue(raw(cookie)),check:async reference=>bindings.isActive(reference),match:async(reference,cookie)=>bindings.matchesCookie(reference,raw(cookie))};
 const appUrl='http://127.0.0.1:3000/buchhaltung',redirect=`${appUrl}/api/auth/callback/oidc`;
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const issuer=`http://127.0.0.1:${server.address().port}/oidc`;
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...privateKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
 const config={issuer,redirect,clientId:'haben',clientSecret:'synthetic-client-secret-123456789012345',subject:'fixture-owner',email:'test@example.invalid',cacheKey:'synthetic-cache-secret-123456789012345',cookieKeys:['synthetic-cookie-secret-123456789012345'],jwks:{keys:[jwk]}};
 const service=createVideomakerOidcService(config,{db:providerDb,binding,allowLoopback:true});
 server.on('request',(req,res)=>void service.handle(req,res));
 const body=`${Date.now()+300000}.${randomBytes(18).toString('base64url')}`,value=`${body}.${signSessionBody(body,vmSecret)}`,vmCookie=`kontrakurs_session=${value}`;
 let sql;
 try{
  sql=await setupTestDb();
  Object.assign(process.env,{BETTER_AUTH_URL:appUrl,OIDC_ONLY:'true',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:config.clientId,OIDC_CLIENT_SECRET:config.clientSecret,OIDC_GROUP_INHABER:'haben-inhaber',OIDC_GROUP_STEUERBERATUNG:'haben-steuerberatung',HABEN_VIDEOMAKER_SESSION_GUARD:'required'});
  vi.stubEnv('BASE_URL','/buchhaltung/');
  const {handleAuth}=await import('../../apps/buchhaltung/apps/web/src/server/auth.ts');
  let requestNumber=0;
  const request=(path,data,cookie='')=>handleAuth(new Request(`${appUrl}/api/auth${path}`,{method:data?'POST':'GET',headers:{origin:'http://127.0.0.1:3000','x-forwarded-for':`127.7.8.${++requestNumber}`,...(data?{'content-type':'application/json'}:{}),cookie},...(data?{body:JSON.stringify(data)}:{})}));
  const start=await request('/sign-in/social',{provider:'oidc',callbackURL:'/buchhaltung/'});
  expect(start.status).toBe(200);
  const stateCookie=start.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  let next=new URL((await start.json()).url);
  expect(next.searchParams.get('redirect_uri')).toBe(redirect);
  expect(next.searchParams.get('code_challenge_method')).toBe('S256');
  expect((await fetch(next,{redirect:'manual'})).status).toBe(401);
  const jar=new Map([['kontrakurs_session',value]]);
  for(let i=0;i<20&&next.origin===new URL(issuer).origin;i++){
   const response=await fetch(next,{redirect:'manual',headers:{cookie:[...jar].map(([key,val])=>`${key}=${val}`).join('; ')}});
   for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
   expect([302,303]).toContain(response.status);next=new URL(response.headers.get('location'),next);
  }
  expect(next.origin+next.pathname).toBe(redirect);
  const code=next.searchParams.get('code'),state=next.searchParams.get('state');expect(code).toBeTruthy();expect(state).toBeTruthy();
  const path=`/callback/oidc?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const result=await request(path,undefined,stateCookie);expect(result.status).toBe(302);
  expect(new URL(result.headers.get('location'),appUrl).searchParams.get('sso')).toBeNull();
  const habenCookie=result.headers.getSetCookie().find(item=>item.includes('session_token='))?.split(';')[0];expect(habenCookie).toBeTruthy();
  const bound=await sql`select reference from videomaker_session_bindings`;expect(bound).toHaveLength(1);expect(bindings.matchesCookie(bound[0].reference,value)).toBe(true);
  const users=await sql`select sso_role from session`;expect(users.map(row=>row.sso_role)).toContain('inhaber');
  const replay=await request(path,undefined,stateCookie);expect(new URL(replay.headers.get('location'),appUrl).searchParams.get('sso')).toBeTruthy();
  const {guardVideomakerSession}=await import('../../apps/buchhaltung/apps/web/src/server/videomaker-session.ts');
  const guardConfig={mode:'required',endpoint:'https://127.0.0.1:4443/api/internal/buchhaltung/session',secret:'synthetischer-guard-schluessel-123456789',bindingSecret:'synthetischer-binding-schluessel-123456789',caFile:'/nur-test'};
  const verifyGuard=async(_endpoint,options)=>options.reference?bindings.matchesCookie(options.reference,raw(options.cookie))?204:401:verifiedSessionBindingProof(vmDb,raw(options.cookie),vmSecret)?204:401;
  const guarded=()=>new Request(`${appUrl}/belege`,{headers:{cookie:`${habenCookie}; ${vmCookie}`}});
  expect(await guardVideomakerSession(guarded(),guardConfig,verifyGuard)).toBeNull();
  revokeSession(vmDb,vmSecret,value,Date.now());
  expect((await guardVideomakerSession(guarded(),guardConfig,verifyGuard)).status).toBe(401);
 }finally{
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  await sql?.end();try{await (await import('../../apps/buchhaltung/apps/web/src/server/db/index.ts')).closeDatabase();}catch{}
  providerDb.close();vmDb.close();vi.unstubAllEnvs();
 }
},120000);
