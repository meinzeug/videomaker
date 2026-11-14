// TEST ONLY: loopback services, synthetic secrets and disposable databases.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {initializeOidcStorage} from '../../lib/oidc-storage.ts';
import {initializeOidcProviderSessionMap} from '../../lib/oidc-provider-session-map.ts';
import {createOidcBindingClient} from '../../lib/oidc-binding-client.ts';
import {createVideomakerOidcService} from '../../lib/videomaker-oidc-service.mjs';

const root=process.env.OIDC_BINDING_TEST_SERVER,testDir=process.env.OIDC_PROVIDER_TEST_DIR;
if(root!=='http://127.0.0.1:3337'||!testDir)throw new Error('Nur für die isolierte Testumgebung.');
const {jwtVerify,createRemoteJWKSet}=await import(pathToFileURL(createRequire(join(testDir,'package.json')).resolve('jose')).href);
const dir=mkdtempSync(join(tmpdir(),'videomaker-oidc-service-flow-')),dbFile=join(dir,'provider.sqlite');
let db=new Database(dbFile);initializeOidcStorage(db);initializeOidcProviderSessionMap(db);
const tlsDir=mkdtempSync(join(homedir(),'.videomaker-oidc-service-flow-')),key=join(tlsDir,'key.pem'),cert=join(tlsDir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=videomaker-session.internal','-addext','subjectAltName=DNS:videomaker-session.internal'],{stdio:'ignore'});
chmodSync(cert,0o600);
const tls=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
 try{const upstream=await fetch(`${root}/api/internal/oidc/session-binding`,{method:'POST',headers:req.headers});res.writeHead(upstream.status,{'cache-control':'no-store'}).end(await upstream.text());}
 catch{res.writeHead(503).end();}
});
await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
const binding=createOidcBindingClient({endpoint:`https://127.0.0.1:${tls.address().port}/api/internal/oidc/session-binding`,secret:'isolated-oidc-bridge-test-secret-123456789',caFile:cert});
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const issuer=`http://127.0.0.1:${server.address().port}/oidc`,redirect='http://127.0.0.1:12345/callback';
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...privateKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const config={issuer,redirect,clientId:'haben',clientSecret:'test-client-secret-12345678901234567890',subject:'test-owner',email:'test@example.invalid',cacheKey:'test-cache-secret-12345678901234567890',cookieKeys:['test-cookie-secret-12345678901234567890'],jwks:{keys:[jwk]}};
let service=createVideomakerOidcService(config,{db,binding,allowLoopback:true});
server.on('request',(req,res)=>void service.handle(req,res));
const login=async()=>{const response=await fetch(`${root}/api/login`,{method:'POST',headers:{origin:root,'content-type':'application/json'},body:JSON.stringify({password:'isolated-oidc-test-password'})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
const logout=async cookie=>assert.equal((await fetch(`${root}/api/logout`,{method:'POST',headers:{origin:root,cookie}})).status,200);
const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const jarOf=cookie=>new Map([[cookie.slice(0,cookie.indexOf('=')),cookie.slice(cookie.indexOf('=')+1)]]);
async function authorize(jar){
 let url=new URL(`${issuer}/auth`);
 for(const [key,value] of Object.entries({client_id:'haben',redirect_uri:redirect,response_type:'code',scope:'openid profile email groups',state:'state-test',nonce:'nonce-test',code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(key,value);
 for(let i=0;i<20&&url.origin===new URL(issuer).origin;i++){
  const response=await fetch(url,{redirect:'manual',headers:{cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')}});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
  if(response.status===401)return null;
  if(response.status!==302&&response.status!==303)throw new Error(`Testautorisierung: HTTP ${response.status}`);
  url=new URL(response.headers.get('location'),url);
 }
 assert.equal(url.origin,'http://127.0.0.1:12345');assert.equal(url.searchParams.get('state'),'state-test');
 return url.searchParams.get('code');
}
async function rejectMidflowCookieSwap(first,second){
 const jar=jarOf(first);let url=new URL(`${issuer}/auth`),interactions=0;
 for(const [key,value] of Object.entries({client_id:'haben',redirect_uri:redirect,response_type:'code',scope:'openid profile email groups',state:'swap-test',nonce:'swap-nonce',code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(key,value);
 for(let i=0;i<20&&url.origin===new URL(issuer).origin;i++){
  const response=await fetch(url,{redirect:'manual',headers:{cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')}});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
  if(response.status===401)return true;
  if(response.status!==302&&response.status!==303)return false;
  if(url.pathname.includes('/interaction/')&&++interactions===1)jar.set('kontrakurs_session',second.split('=')[1]);
  url=new URL(response.headers.get('location'),url);
 }
 return false;
}
const basic=Buffer.from(`haben:${config.clientSecret}`).toString('base64');
const exchange=(code,proof=verifier)=>fetch(`${issuer}/token`,{method:'POST',headers:{authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:proof})});
try{
 const first=await login(),second=await login(),jar=jarOf(first);
 assert.equal(await authorize(new Map()),null);
 assert.equal(await rejectMidflowCookieSwap(first,second),true,'Sitzungstausch während des Logins wird abgewiesen');
 const code=await authorize(jar);assert.ok(code);
 let response=await exchange(code);assert.equal(response.status,200);const tokens=await response.json();
 const {payload}=await jwtVerify(tokens.id_token,createRemoteJWKSet(new URL(`${issuer}/jwks`)),{issuer,audience:'haben',nonce:'nonce-test'});
 assert.equal(payload.sub,'test-owner');
 assert.equal(await binding.match(payload.videomaker_session_ref,first),true);
 assert.equal(await binding.match(payload.videomaker_session_ref,second),false);
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,200);
 assert.deepEqual((await response.json()).groups,['haben-inhaber']);
 db.close();db=new Database(dbFile);service=createVideomakerOidcService(config,{db,binding,allowLoopback:true});
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,200,'Providerzustand überlebt Neustart');
 const afterRestart=await authorize(jar);assert.ok(afterRestart,'Dieselbe gültige Videomaker-Sitzung kann sich nach Neustart erneut anmelden');
 response=await exchange(afterRestart);assert.equal(response.status,200);
 const restartedPayload=(await jwtVerify((await response.json()).id_token,createRemoteJWKSet(new URL(`${issuer}/jwks`)),{issuer,audience:'haben',nonce:'nonce-test'})).payload;
 assert.equal(await binding.match(restartedPayload.videomaker_session_ref,first),true);
 await logout(first);assert.equal(await binding.match(payload.videomaker_session_ref,first),false);
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,401);
 assert.equal((await exchange(code)).status,400,'Code darf nicht erneut eingelöst werden');
 jar.set('kontrakurs_session',second.split('=')[1]);const secondCode=await authorize(jar);assert.ok(secondCode);
 response=await exchange(secondCode);assert.equal(response.status,200);const secondTokens=await response.json();
 const secondPayload=(await jwtVerify(secondTokens.id_token,createRemoteJWKSet(new URL(`${issuer}/jwks`)),{issuer,audience:'haben',nonce:'nonce-test'})).payload;
 assert.equal(await binding.match(secondPayload.videomaker_session_ref,second),true);
 assert.equal(await binding.match(secondPayload.videomaker_session_ref,first),false);
 const badCode=await authorize(jarOf(second));assert.ok(badCode);assert.equal((await exchange(badCode,'x'.repeat(64))).status,400);
 const pending=await authorize(jarOf(second));assert.ok(pending);await logout(second);assert.equal((await exchange(pending)).status,400);
 console.log('OIDC-Dienst: PKCE, Signatur, feste Sitzungsbindung, Neustart, Logout und ausstehender Code geprüft.');
}finally{
 await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>tls.close(resolve));db.close();
 rmSync(dir,{recursive:true,force:true});rmSync(tlsDir,{recursive:true,force:true});
}
