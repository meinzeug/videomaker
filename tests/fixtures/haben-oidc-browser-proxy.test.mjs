// TEST ONLY. A real browser, OIDC service and Haben auth handler behind a local proxy.
// The page shell and TLS bridge server are fixtures, not the production UI/proxy.
import {test,expect,vi} from 'vitest';
import {createServer,request as httpRequest} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createVideomakerOidcService} from '../../lib/videomaker-oidc-service.mjs';
import {createOidcBindingClient} from '../../lib/oidc-binding-client.ts';
import {initializeOidcStorage} from '../../lib/oidc-storage.ts';
import {initializeOidcProviderSessionMap} from '../../lib/oidc-provider-session-map.ts';
import {createOidcSessionBindings,initializeOidcSessionBindings} from '../../lib/oidc-session-bindings.ts';
import {verifiedSessionBindingProof} from '../../lib/session-binding-proof.ts';
import {sessionRevoked,revokeSession} from '../../lib/session-revocations.ts';
import {signSessionBody} from '../../lib/session-cookie.ts';
import {setupTestDb} from '../../apps/buchhaltung/apps/web/src/server/test-db.ts';

test('browser follows proxy SSO and the real Haben guard rejects a revoked session',async()=>{
 const require=createRequire(new URL('../../apps/buchhaltung/apps/web/package.json',import.meta.url));
 const {chromium}=require('@playwright/test');
 const vmDb=new Database(':memory:'),providerDb=new Database(':memory:');
 const vmSecret='synthetischer-videomaker-testschluessel-123456789';
 initializeOidcStorage(providerDb);initializeOidcProviderSessionMap(providerDb);
 sessionRevoked(vmDb,vmSecret,'testinitialisierung');initializeOidcSessionBindings(vmDb);
 const bindings=createOidcSessionBindings(vmDb,(db,value)=>verifiedSessionBindingProof(db,value,vmSecret),Date.now,()=>vmSecret);
 const raw=cookie=>cookie.startsWith('kontrakurs_session=')?cookie.slice('kontrakurs_session='.length):'';
 const tlsDir=mkdtempSync(join(homedir(),'.videomaker-browser-guard-tls-')),key=join(tlsDir,'key.pem'),cert=join(tlsDir,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=videomaker-session.internal','-addext','subjectAltName=DNS:videomaker-session.internal'],{stdio:'ignore'});chmodSync(cert,0o600);
 const guardSecret='synthetischer-guard-schluessel-123456789',bindingSecret='synthetischer-binding-schluessel-123456789';
 const tls=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  try{
   const cookie=raw(req.headers.cookie||''),reference=req.headers['x-oidc-session-reference']||'';
   if(req.url==='/api/internal/buchhaltung/session'&&req.method==='GET'&&req.headers['x-videomaker-internal-secret']===guardSecret){res.writeHead(verifiedSessionBindingProof(vmDb,cookie,vmSecret)?204:401).end();return;}
   if(req.url!=='/api/internal/oidc/session-binding'||req.method!=='POST'||req.headers['x-videomaker-internal-secret']!==bindingSecret||req.headers['content-length']!=='0'){res.writeHead(401).end();return;}
   const operation=req.headers['x-oidc-binding-operation'];
   if(operation==='issue'){const issued=bindings.issue(cookie);if(!issued){res.writeHead(401).end();return;}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({reference:issued}));return;}
   if(operation==='check'){res.writeHead(bindings.isActive(reference)?204:401).end();return;}
   if(operation==='match'){res.writeHead(bindings.matchesCookie(reference,cookie)?204:401).end();return;}
   res.writeHead(400).end();
  }catch{res.writeHead(503).end();}
 });
 await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
 const binding=createOidcBindingClient({endpoint:`https://127.0.0.1:${tls.address().port}/api/internal/oidc/session-binding`,secret:bindingSecret,caFile:cert});
 const proxy=createServer(),upstream=createServer();
 await Promise.all([new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))]);
 const origin=`http://127.0.0.1:${proxy.address().port}`,appUrl=`${origin}/buchhaltung`,issuer=`${origin}/oidc`;
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...privateKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
 const config={issuer,redirect:`${appUrl}/api/auth/callback/oidc`,clientId:'haben',clientSecret:'synthetic-client-secret-123456789012345',subject:'fixture-owner',email:'test@example.invalid',cacheKey:'synthetic-cache-secret-123456789012345',cookieKeys:['synthetic-cookie-secret-123456789012345'],jwks:{keys:[jwk]}};
 const service=createVideomakerOidcService(config,{db:providerDb,binding,allowLoopback:true});
 upstream.on('request',(req,res)=>void service.handle(req,res));
 const body=`${Date.now()+300000}.${randomBytes(18).toString('base64url')}`,value=`${body}.${signSessionBody(body,vmSecret)}`;
 let sql,browser,handleAuth,guard,oidcForwarded=0;
 const guardConfig={mode:'required',endpoint:`https://127.0.0.1:${tls.address().port}/api/internal/buchhaltung/session`,secret:guardSecret,bindingSecret,caFile:cert};
 async function webRequest(req){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const content=Buffer.concat(chunks);
  return new Request(origin+req.url,{method:req.method,headers:req.headers,...(content.length?{body:content}: {})});
 }
 async function webResponse(res,response){
  const headers={};for(const [key,val] of response.headers)if(key.toLowerCase()!=='set-cookie')headers[key]=val;
  const cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies;
  res.writeHead(response.status,headers).end(Buffer.from(await response.arrayBuffer()));
 }
 proxy.on('request',async(req,res)=>{
  try{
   if(req.url.startsWith('/oidc/')){
    oidcForwarded++;
    const headers={...req.headers,host:new URL(origin).host};
    for(const name of Object.keys(headers))if(name.toLowerCase().startsWith('x-forwarded-'))delete headers[name];
    const forward=httpRequest({host:'127.0.0.1',port:upstream.address().port,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    forward.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(forward);return;
   }
   if(req.url==='/fixture/login'){
    res.writeHead(200,{'content-type':'text/html','set-cookie':`kontrakurs_session=${value}; Path=/; HttpOnly; SameSite=Lax`}).end(`<!doctype html><button id="login">Anmelden</button><script>document.querySelector('#login').onclick=async()=>{const r=await fetch('/buchhaltung/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'oidc',callbackURL:'/buchhaltung/'})});if(!r.ok){document.body.textContent='SSO_START_FAILED';return}location.href=(await r.json()).url}</script>`);return;
   }
   if(req.url==='/fixture/logout'&&req.method==='POST'){revokeSession(vmDb,vmSecret,value,Date.now());res.writeHead(204).end();return;}
   if(req.url.startsWith('/buchhaltung/api/auth/')){await webResponse(res,await handleAuth(await webRequest(req)));return;}
   if(req.url==='/buchhaltung/'||req.url==='/buchhaltung'){
    const rejection=await guard(await webRequest(req),guardConfig);
    if(rejection){await webResponse(res,rejection);return;}
    res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Fixture</title><p>HABEN_AUTHENTICATED_FIXTURE</p>');return;
   }
   res.writeHead(404).end();
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 try{
  sql=await setupTestDb();
  Object.assign(process.env,{BETTER_AUTH_URL:appUrl,OIDC_ONLY:'true',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:config.clientId,OIDC_CLIENT_SECRET:config.clientSecret,OIDC_GROUP_INHABER:'haben-inhaber',OIDC_GROUP_STEUERBERATUNG:'haben-steuerberatung',HABEN_VIDEOMAKER_SESSION_GUARD:'required'});
  vi.stubEnv('BASE_URL','/buchhaltung/');
  ({handleAuth}=await import('../../apps/buchhaltung/apps/web/src/server/auth.ts'));
  ({guardVideomakerSession:guard}=await import('../../apps/buchhaltung/apps/web/src/server/videomaker-session.ts'));
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--disable-dev-shm-usage','--disable-gpu']});
  const context=await browser.newContext();const page=await context.newPage();
  await page.goto(`${origin}/fixture/login`);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await page.waitForURL(`${appUrl}/`,{timeout:20000});
  expect(await page.locator('body').innerText()).toContain('HABEN_AUTHENTICATED_FIXTURE');
  expect(oidcForwarded).toBeGreaterThan(0);
  const sessions=await sql`select sso_role from session`;expect(sessions.map(row=>row.sso_role)).toContain('inhaber');
  expect((await sql`select count(*)::int as n from videomaker_session_bindings`)[0].n).toBe(1);
  await page.evaluate(()=>fetch('/fixture/logout',{method:'POST'}));
  const after=await page.reload();expect(after?.status()).toBe(401);
  await context.close();
 }finally{
  await browser?.close();await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});await new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();});await new Promise(resolve=>{tls.close(resolve);tls.closeAllConnections();});
  await sql?.end();try{await (await import('../../apps/buchhaltung/apps/web/src/server/db/index.ts')).closeDatabase();}catch{}
  providerDb.close();vmDb.close();vi.unstubAllEnvs();rmSync(tlsDir,{recursive:true,force:true});
 }
},120000);
