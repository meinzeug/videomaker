import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import Database from 'better-sqlite3';
import {initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';
import {createDeviceHttpFixture} from '../experiments/studio-device-http/router.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
async function setup(){
 const db=new Database(':memory:');initializeStudioDeviceAuth(db);db.exec('CREATE TABLE fixture_browser_sessions(token_hash TEXT PRIMARY KEY,csrf_hash TEXT NOT NULL)');
 const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO fixture_browser_sessions VALUES(?,?)').run(hash(token),hash(csrf));
 let now=1_000_000;
 const handler=createDeviceHttpFixture({db,challengeSecret:randomBytes(32),ownerSecret:randomBytes(32),clock:()=>now});
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser={'Origin':'https://fixture.invalid','Cookie':`fixture_session=${token}`,'X-Fixture-CSRF':csrf};
 async function request(path,body,headers=browser){
  const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:res.status,value:await res.json(),headers:res.headers};
 }
 return {db,server,base,browser,request,advance(ms){now+=ms;},async close(){await new Promise(resolve=>server.close(resolve));db.close();}};
}
function identity(){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {deviceId:randomUUID(),keys,pub:keys.publicKey.export({type:'spki',format:'der'})};}
function enrollMessage(who,c){return Buffer.from(`videomaker-studio-device-auth/enroll/v1\n${who.deviceId}\n${c.challengeId}\n${c.nonce}\n${hash(who.pub)}\n${[...c.scope].sort().join(',')}\n${c.ownerHash}\n`);}
function loginMessage(who,c){return Buffer.from(`videomaker-studio-device-auth/login/v1\n${who.deviceId}\n${c.challengeToken}\n${hash(who.pub)}\nprojects:read,recordings:upload\n`);}
const proof=(message,key)=>sign('sha256',message,key).toString('base64url');
async function enroll(f,who){
 const begin=await f.request('/fixture/enroll/begin',{deviceId:who.deviceId,publicKey:who.pub.toString('base64url')});assert.equal(begin.status,200);
 const signature=proof(enrollMessage(who,begin.value),who.keys.privateKey);
 const complete=await f.request('/fixture/enroll/complete',{deviceId:who.deviceId,challengeId:begin.value.challengeId,signature});assert.equal(complete.status,200);
 return {begin:begin.value,signature};
}
test('HTTP fixture separates browser authority, device proof, scoped ticket, replay and revoke',async()=>{
 const f=await setup(),who=identity();try{
  const payload={deviceId:who.deviceId,publicKey:who.pub.toString('base64url')};
  assert.equal((await f.request('/fixture/enroll/begin',payload,{})).status,403);
  assert.equal((await f.request('/fixture/enroll/begin',payload,{...f.browser,Origin:'https://wrong.invalid'})).status,403);
  assert.equal((await f.request('/fixture/enroll/begin',payload,{...f.browser,'X-Fixture-CSRF':'wrong'})).status,403);
  assert.equal((await f.request('/fixture/enroll/begin',{...payload,ownerHash:'a'.repeat(64)})).status,400);
  const existing=await enroll(f,who);
  assert.equal((await f.request('/fixture/enroll/complete',{deviceId:who.deviceId,challengeId:existing.begin.challengeId,signature:existing.signature})).status,403);
  const login=await f.request('/fixture/login/begin',{deviceId:who.deviceId},{});assert.equal(login.status,200);
  const signature=proof(loginMessage(who,login.value),who.keys.privateKey),request={deviceId:who.deviceId,challengeToken:login.value.challengeToken,signature};
  const competing=await Promise.all([f.request('/fixture/login/complete',request,{}),f.request('/fixture/login/complete',request,{})]);
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,403]);
  const ticket=competing.find(r=>r.status===200).value.ticket;
  const projects=await fetch(f.base+'/fixture/projects',{headers:{Authorization:`Bearer ${ticket}`}});assert.equal(projects.status,200);assert.equal(projects.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(f.base+'/fixture/admin',{headers:{Authorization:`Bearer ${ticket}`}})).status,403);
  assert.equal((await f.request('/fixture/revoke',{deviceId:who.deviceId})).status,200);
  assert.equal((await fetch(f.base+'/fixture/projects',{headers:{Authorization:`Bearer ${ticket}`}})).status,403);
  assert.equal((await f.request('/fixture/login/begin',{deviceId:who.deviceId},{})).status,403);
 }finally{await f.close();}
});
test('browser logout before proof prevents enrollment; expiry rejects pending login',async()=>{
 const f=await setup(),who=identity();try{
  const begin=await f.request('/fixture/enroll/begin',{deviceId:who.deviceId,publicKey:who.pub.toString('base64url')});assert.equal(begin.status,200);
  const signature=proof(enrollMessage(who,begin.value),who.keys.privateKey);
  assert.equal((await f.request('/fixture/logout',{})).status,200);
  assert.equal((await f.request('/fixture/enroll/complete',{deviceId:who.deviceId,challengeId:begin.value.challengeId,signature})).status,403);
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n,0);
 }finally{await f.close();}
 const g=await setup(),other=identity();try{
  await enroll(g,other);const login=await g.request('/fixture/login/begin',{deviceId:other.deviceId},{});
  const signature=proof(loginMessage(other,login.value),other.keys.privateKey);g.advance(60_001);
  assert.equal((await g.request('/fixture/login/complete',{deviceId:other.deviceId,challengeToken:login.value.challengeToken,signature},{})).status,403);
 }finally{await g.close();}
});
test('incomplete slowly sent JSON cannot hold a fixture request forever',{timeout:7000},async()=>{
 const f=await setup();try{
  const status=await new Promise((resolve,reject)=>{
   const req=httpRequest(f.base+'/fixture/login/begin',{method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.write('{');
  });
  assert.equal(status,400);
 }finally{await f.close();}
});
