// TEST ONLY: this test creates and drops databases in the explicitly marked fixture cluster.
import {test,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {createOidcStorageAdapter,initializeOidcStorage} from '../../lib/oidc-storage.ts';
import {createOidcProviderSessionMap,initializeOidcProviderSessionMap} from '../../lib/oidc-provider-session-map.ts';
import {createOidcSessionBindings,initializeOidcSessionBindings} from '../../lib/oidc-session-bindings.ts';
import {verifiedSessionBindingProof} from '../../lib/session-binding-proof.ts';
import {sessionRevoked,revokeSession} from '../../lib/session-revocations.ts';
import {signSessionBody} from '../../lib/session-cookie.ts';
import {setupTestDb} from '../../apps/buchhaltung/apps/web/src/server/test-db.ts';

test('Haben-Callback unter Buchhaltung akzeptiert ein gebundenes Videomaker-Testkonto',async()=>{
 const testDir=process.env.OIDC_PROVIDER_TEST_DIR;
 if(!testDir||!isAbsolute(testDir))throw new Error('Isolierte OIDC-Provider-Testabhängigkeit fehlt.');
 const require=createRequire(join(testDir,'package.json'));
 const {Provider}=await import(pathToFileURL(require.resolve('oidc-provider')).href);
 const vmDb=new Database(':memory:'),providerDb=new Database(':memory:');
 const vmSecret='synthetischer-videomaker-testschluessel-123456789';
 initializeOidcStorage(providerDb);initializeOidcProviderSessionMap(providerDb);
 sessionRevoked(vmDb,vmSecret,'testinitialisierung');initializeOidcSessionBindings(vmDb);
 const bindings=createOidcSessionBindings(vmDb,(db,value)=>verifiedSessionBindingProof(db,value,vmSecret),Date.now,()=>vmSecret);
 const sessionMap=createOidcProviderSessionMap(providerDb);
 const body=`${Date.now()+300000}.testnonce`;
 const vmCookie=`kontrakurs_session=${body}.${signSessionBody(body,vmSecret)}`;
 const vmValue=vmCookie.slice('kontrakurs_session='.length);
 const matchesVmCookie=(header='')=>{
  const cookies=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith('kontrakurs_session='));
  return cookies.length===1&&cookies[0]===vmCookie;
 };
 const issued=bindings.issue(vmValue);expect(issued).toBeTruthy();
 const appUrl='http://localhost:3000/buchhaltung';
 const callback=`${appUrl}/api/auth/callback/oidc`;
 const providerServer=createServer();
 await new Promise(resolve=>providerServer.listen(0,'127.0.0.1',resolve));
 const issuer=`http://127.0.0.1:${providerServer.address().port}`;
 const clientSecret='ausschliesslich-synthetisches-client-secret-12345';
 const provider=new Provider(issuer,{
  adapter:createOidcStorageAdapter(providerDb),
  clients:[{client_id:'haben',client_secret:clientSecret,redirect_uris:[callback],response_types:['code'],grant_types:['authorization_code'],token_endpoint_auth_method:'client_secret_basic'}],
  features:{devInteractions:{enabled:false}},
  interactions:{url:(_ctx,interaction)=>`/interaction/${interaction.uid}`},
  findAccount:async(ctx,accountId,source)=>{
   const allowed=source?bindings.isActive(sessionMap.find(source.sessionUid)||''):matchesVmCookie(ctx.req.headers.cookie)&&bindings.isActive(issued);
   return allowed?{accountId,claims:async()=>({sub:accountId,email:'test@example.invalid',email_verified:true,groups:['haben-inhaber']})}:undefined;
  },
  claims:{openid:['sub'],profile:['name'],email:['email','email_verified'],groups:['groups']},
  scopes:['openid','profile','email','groups'],pkce:{required:()=>true,methods:['S256']},
 });
 providerServer.on('request',async(req,res)=>{
  try{
   if((req.url.startsWith('/auth')||req.url.startsWith('/interaction/'))&&(!matchesVmCookie(req.headers.cookie)||!bindings.isActive(issued))){res.writeHead(401).end();return;}
   if(!req.url.startsWith('/interaction/'))return provider.callback()(req,res);
   const interaction=await provider.interactionDetails(req,res);let result;
   if(interaction.prompt.name==='login')result={login:{accountId:'videomaker-fixture-owner'}};
   else if(interaction.prompt.name==='consent'){
    sessionMap.bindOnce(interaction.session.uid,issued);
    const grant=new provider.Grant({accountId:interaction.session.accountId,clientId:interaction.params.client_id});
    grant.addOIDCScope('openid profile email groups');result={consent:{grantId:await grant.save()}};
   }else throw new Error('Nicht unterstützte Testinteraktion');
   await provider.interactionFinished(req,res,result,{mergeWithLastSubmission:false});
  }catch{res.writeHead(500).end();}
 });
 let sql;
 try{
  sql=await setupTestDb();
  Object.assign(process.env,{BETTER_AUTH_URL:appUrl,OIDC_ONLY:'true',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:'haben',OIDC_CLIENT_SECRET:clientSecret,OIDC_GROUP_INHABER:'haben-inhaber',OIDC_GROUP_STEUERBERATUNG:'haben-steuerberatung'});
  vi.stubEnv('BASE_URL','/buchhaltung/');
  const {handleAuth}=await import('../../apps/buchhaltung/apps/web/src/server/auth.ts');
  const {appPath}=await import('../../apps/buchhaltung/apps/web/src/lib/app-path.ts');
  expect(appPath('/api/auth')).toBe('/buchhaltung/api/auth');
  const request=(path,body,cookie='')=>handleAuth(new Request(`${appUrl}/api/auth${path}`,{method:body?'POST':'GET',headers:{origin:'http://localhost:3000','x-forwarded-for':'127.7.7.7',...(body?{'content-type':'application/json'}:{}),cookie},...(body?{body:JSON.stringify(body)}:{})}));
  const start=await request('/sign-in/social',{provider:'oidc',callbackURL:'/buchhaltung/'});
  expect(start.status,`SSO-Start antwortete ${start.status}: ${start.status===200?'':await start.text()}`).toBe(200);
  const habenCookie=start.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  let next=new URL((await start.json()).url);
  expect(next.searchParams.get('redirect_uri')).toBe(callback);
  expect(next.searchParams.get('code_challenge_method')).toBe('S256');
  expect((await fetch(next,{redirect:'manual'})).status).toBe(401);
  expect((await fetch(next,{redirect:'manual',headers:{cookie:`${vmCookie}; ${vmCookie}`}})).status).toBe(401);
  const jar=new Map([[vmCookie.split('=')[0],vmCookie.split('=')[1]]]);
  for(let i=0;i<15&&next.origin===issuer;i++){
   const response=await fetch(next,{redirect:'manual',headers:{cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')}});
   for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],pos=pair.indexOf('=');jar.set(pair.slice(0,pos),pair.slice(pos+1));}
   expect([302,303]).toContain(response.status);next=new URL(response.headers.get('location'),next);
  }
  expect(next.origin+next.pathname).toBe(callback);
  const code=next.searchParams.get('code'),state=next.searchParams.get('state');
  expect(code).toBeTruthy();expect(state).toBeTruthy();
  const result=await request(`/callback/oidc?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,undefined,habenCookie);
  expect(result.status).toBe(302);
  expect(new URL(result.headers.get('location'),appUrl).searchParams.get('sso')).toBeNull();
  const accounts=await sql`select account_id from account where provider_id='oidc'`;
  expect(accounts.map(row=>row.account_id)).toContain(JSON.stringify([issuer,'videomaker-fixture-owner']));
  const sessions=await sql`select sso_role from session`;
  expect(sessions.map(row=>row.sso_role)).toContain('inhaber');
  const replay=await request(`/callback/oidc?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,undefined,habenCookie);
  expect(new URL(replay.headers.get('location'),appUrl).searchParams.get('sso')).toBeTruthy();
  revokeSession(vmDb,vmSecret,vmValue,Date.now());
  expect(bindings.isActive(issued)).toBe(false);
  const afterLogout=await request('/sign-in/social',{provider:'oidc',callbackURL:'/buchhaltung/'});
  expect(afterLogout.status).toBe(200);
  const blocked=await fetch((await afterLogout.json()).url,{redirect:'manual',headers:{cookie:vmCookie}});
  expect(blocked.status).toBe(401);
  // Haben has a separate session store. Without the production session guard,
  // this test must not claim that a Videomaker logout also deletes that session.
  const remaining=await sql`select count(*)::int as n from session`;
  expect(remaining[0].n).toBeGreaterThan(0);
 }finally{
  await new Promise(resolve=>{providerServer.close(resolve);providerServer.closeAllConnections();});
  await sql?.end();
  try{await (await import('../../apps/buchhaltung/apps/web/src/server/db/index.ts')).closeDatabase();}catch{}
  providerDb.close();vmDb.close();
  vi.unstubAllEnvs();
 }
},120000);
