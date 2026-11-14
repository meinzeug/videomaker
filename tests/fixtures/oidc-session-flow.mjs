// TEST ONLY: development keys, synthetic account, loopback servers and temporary databases.
// This is not a deployable identity provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { chmodSync,mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { homedir,tmpdir } from 'node:os';
import { join,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createOidcStorageAdapter,initializeOidcStorage } from '../../lib/oidc-storage.ts';
import { createOidcProviderSessionMap,initializeOidcProviderSessionMap } from '../../lib/oidc-provider-session-map.ts';
import { createOidcBindingClient } from '../../lib/oidc-binding-client.ts';

const root=process.env.OIDC_BINDING_TEST_SERVER, testDirectory=process.env.OIDC_PROVIDER_TEST_DIR;
if(root!=='http://127.0.0.1:3337'||!testDirectory||!isAbsolute(testDirectory))throw new Error('Ausschließlich für die isolierte Loopback-Testumgebung.');
const require=createRequire(join(testDirectory,'package.json'));
const {Provider}=await import(pathToFileURL(require.resolve('oidc-provider')).href);
const secret='isolated-oidc-bridge-test-secret-123456789',password='isolated-oidc-test-password';
const clientSecret='nur-synthetisches-test-client-secret-123456789',redirect='http://127.0.0.1:12345/callback';
const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-flow-')),databaseFile=join(directory,'provider.sqlite');
const db=new Database(databaseFile);initializeOidcStorage(db);initializeOidcProviderSessionMap(db);
let mapDb=new Database(databaseFile),map=createOidcProviderSessionMap(mapDb);
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const issuer=`http://127.0.0.1:${server.address().port}`;
const references=new Map();
// Isolated TLS proxy for the real local binding route; no production keys or hosts.
const tlsDir=mkdtempSync(join(homedir(),'.videomaker-oidc-flow-'));
const tlsKey=join(tlsDir,'key.pem'),tlsCert=join(tlsDir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',tlsCert,'-days','1','-subj','/CN=videomaker-session.internal','-addext','subjectAltName=DNS:videomaker-session.internal'],{stdio:'ignore'});
chmodSync(tlsCert,0o600);
const tlsServer=createHttpsServer({key:readFileSync(tlsKey),cert:readFileSync(tlsCert)},async(req,res)=>{
 try{
  if(req.method!=='POST'||req.url!=='/api/internal/oidc/session-binding'){res.writeHead(404).end();return;}
  const response=await fetch(`${root}/api/internal/oidc/session-binding`,{method:'POST',headers:req.headers});
  res.writeHead(response.status,{'cache-control':'no-store'}).end(await response.text());
 }catch{res.writeHead(503).end();}
});
await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
const binding=createOidcBindingClient({endpoint:`https://127.0.0.1:${tlsServer.address().port}/api/internal/oidc/session-binding`,secret,caFile:tlsCert});

async function login(){
 const response=await fetch(`${root}/api/login`,{method:'POST',headers:{origin:root,'content-type':'application/json'},body:JSON.stringify({password})});
 assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
async function logout(cookie){
 const response=await fetch(`${root}/api/logout`,{method:'POST',headers:{origin:root,cookie}});assert.equal(response.status,200);
}
async function issue(cookie){
 const matches=(cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith('kontrakurs_session='));
 if(matches.length!==1)return null;
 const previous=references.get(matches[0]);
 if(previous&&await active(previous))return previous;
 const reference=await binding.issue(matches[0]);if(!reference)return null;
 references.set(matches[0],reference);return reference;
}
async function active(reference){
 if(!reference)return false;
 return binding.check(reference);
}
const provider=new Provider(issuer,{
 adapter:createOidcStorageAdapter(db),
 clients:[{client_id:'haben',client_secret:clientSecret,redirect_uris:[redirect],response_types:['code'],grant_types:['authorization_code'],token_endpoint_auth_method:'client_secret_basic'}],
 features:{devInteractions:{enabled:false}},
 interactions:{url:(_ctx,interaction)=>`/interaction/${interaction.uid}`},
 findAccount:async(ctx,accountId,source)=>{
  const allowed=source?await active(map.find(source.sessionUid)):Boolean(await issue(ctx.req.headers.cookie));
  return allowed?{accountId,claims:async()=>({sub:accountId,email:'test@example.invalid',email_verified:true,groups:['haben-inhaber']})}:undefined;
 },
 claims:{openid:['sub'],profile:['name'],email:['email','email_verified'],groups:['groups']},
 scopes:['openid','profile','email','groups'],pkce:{required:()=>true,methods:['S256']},
});
server.on('request',async(req,res)=>{
 try {
  if(req.url.startsWith('/auth')||req.url.startsWith('/interaction/')){
   if(!await issue(req.headers.cookie)){res.writeHead(401).end();return;}
  }
  if(!req.url.startsWith('/interaction/'))return provider.callback()(req,res);
  const interaction=await provider.interactionDetails(req,res);
  let result;
  if(interaction.prompt.name==='login')result={login:{accountId:'test-inhaber'}};
  else if(interaction.prompt.name==='consent'){
   const uid=interaction.session?.uid,reference=await issue(req.headers.cookie);
   if(!uid||!reference){res.writeHead(401).end();return;}
   try{map.bindOnce(uid,reference);}catch{res.writeHead(401).end();return;}
   const grant=new provider.Grant({accountId:interaction.session.accountId,clientId:interaction.params.client_id});
   grant.addOIDCScope('openid profile email groups');result={consent:{grantId:await grant.save()}};
  } else throw new Error('Nicht unterstützte Interaktion');
  await provider.interactionFinished(req,res,result,{mergeWithLastSubmission:false});
 } catch {res.writeHead(500).end();}
});

const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const basic=Buffer.from(`haben:${clientSecret}`).toString('base64');
const jarWithCookie=cookie=>new Map([[cookie.slice(0,cookie.indexOf('=')),cookie.slice(cookie.indexOf('=')+1)]]);
async function authorize(jar){
 let url=new URL('/auth',issuer);
 for(const [k,v] of Object.entries({client_id:'haben',redirect_uri:redirect,response_type:'code',scope:'openid profile email groups',state:'state-test',nonce:'nonce-test',code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(k,v);
 for(let i=0;i<15&&url.origin===issuer;i++){
  const response=await fetch(url,{redirect:'manual',headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}});
  for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';'),j=pair.indexOf('=');jar.set(pair.slice(0,j),pair.slice(j+1));}
  if(response.status===401)return null;
  if(response.status!==302&&response.status!==303)throw new Error(`Autorisierung fehlgeschlagen: ${response.status}`);
  url=new URL(response.headers.get('location'),url);
 }
 assert.equal(url.origin,'http://127.0.0.1:12345');assert.equal(url.searchParams.get('state'),'state-test');
 const code=url.searchParams.get('code');assert.ok(code);return code;
}
const exchange=code=>fetch(`${issuer}/token`,{method:'POST',headers:{authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier})});
try {
 const firstCookie=await login(),oldJar=jarWithCookie(firstCookie),firstCode=await authorize(oldJar);
 assert.ok(firstCode);
 let response=await exchange(firstCode);assert.equal(response.status,200);const tokens=await response.json();
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,200);
 // The UID-to-reference binding must survive a real SQLite close/reopen.
 mapDb.close();mapDb=new Database(databaseFile);map=createOidcProviderSessionMap(mapDb);
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,200);
 await logout(firstCookie);
 response=await fetch(`${issuer}/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}});assert.equal(response.status,401);
 assert.equal(await authorize(oldJar),null);

 const secondCookie=await login();oldJar.set('kontrakurs_session',secondCookie.split('=')[1]);
 const oldSessionCode=await authorize(oldJar);
 if(oldSessionCode)assert.equal((await exchange(oldSessionCode)).status,400);

 const freshJar=jarWithCookie(secondCookie),pendingCode=await authorize(freshJar);assert.ok(pendingCode);
 await logout(secondCookie);
 assert.equal((await exchange(pendingCode)).status,400);
 console.log('OIDC + echte Video-Maker-Testsession über gepinnten Test-TLS-Endpunkt: Anmeldung, UserInfo, Logout, alte Provider-Session und ausstehender Code geprüft.');
} finally {await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>tlsServer.close(resolve));mapDb.close();db.close();rmSync(directory,{recursive:true,force:true});rmSync(tlsDir,{recursive:true,force:true});}
