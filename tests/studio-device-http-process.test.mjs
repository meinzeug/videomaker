import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const sign64=(message,key)=>sign('sha256',Buffer.from(message),key).toString('base64url');
test('two HTTP processes serialize replay, revocation and browser logout against shared fixture DB',{timeout:30000},async()=>{
 const root=mkdtempSync('/dev/shm/studio-http-race.'),file=join(root,'synthetic.sqlite'),db=new Database(file);
 db.pragma('synchronous=FULL');initializeStudioDeviceAuth(db);db.exec('CREATE TABLE fixture_browser_sessions(token_hash TEXT PRIMARY KEY,csrf_hash TEXT NOT NULL)');
 const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO fixture_browser_sessions VALUES(?,?)').run(hash(token),hash(csrf));
 const challenge=randomBytes(32).toString('hex'),owner=randomBytes(32).toString('hex');
 const workers=[0,1].map(()=>fork(new URL('./fixtures/studio-device-http-worker.mjs',import.meta.url),[file,challenge,owner],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=workers.map(w=>new Promise(resolve=>w.once('exit',(code,signal)=>resolve({code,signal}))));
 try{
  const ports=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',x=>resolve(x.port));w.once('error',reject);w.once('exit',code=>reject(Error(`fixture worker exit ${code}`)));})));
  const origin='https://fixture.invalid',browser={Origin:origin,Cookie:`fixture_session=${token}`,'X-Fixture-CSRF':csrf};
  async function post(index,path,body,headers=browser){
   const response=await fetch(`http://127.0.0.1:${ports[index]}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
   return {status:response.status,value:await response.json()};
  }
  async function get(index,path,ticket){return fetch(`http://127.0.0.1:${ports[index]}${path}`,{headers:{Authorization:`Bearer ${ticket}`}});}
  function createIdentity(){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {id:randomUUID(),keys,pub:keys.publicKey.export({type:'spki',format:'der'})};}
  function enrollmentProof(device,c){return sign64(`videomaker-studio-device-auth/enroll/v1\n${device.id}\n${c.challengeId}\n${c.nonce}\n${hash(device.pub)}\n${[...c.scope].sort().join(',')}\n${c.ownerHash}\n`,device.keys.privateKey);}
  function loginProof(device,c){return sign64(`videomaker-studio-device-auth/login/v1\n${device.id}\n${c.challengeToken}\n${hash(device.pub)}\nprojects:read,recordings:upload\n`,device.keys.privateKey);}
  const device=createIdentity(),begin=await post(0,'/fixture/enroll/begin',{deviceId:device.id,publicKey:device.pub.toString('base64url')});assert.equal(begin.status,200);
  assert.equal((await post(1,'/fixture/enroll/complete',{deviceId:device.id,challengeId:begin.value.challengeId,signature:enrollmentProof(device,begin.value)})).status,200);
  const login=await post(0,'/fixture/login/begin',{deviceId:device.id},{});assert.equal(login.status,200);
  const request={deviceId:device.id,challengeToken:login.value.challengeToken,signature:loginProof(device,login.value)};
  const replay=await Promise.all([post(0,'/fixture/login/complete',request,{}),post(1,'/fixture/login/complete',request,{})]);
  assert.deepEqual(replay.map(x=>x.status).sort(),[200,403]);const oldTicket=replay.find(x=>x.status===200).value.ticket;
  const next=await post(1,'/fixture/login/begin',{deviceId:device.id},{}),pending={deviceId:device.id,challengeToken:next.value.challengeToken,signature:loginProof(device,next.value)};
  const [loginRace,revoke]=await Promise.all([post(0,'/fixture/login/complete',pending,{}),post(1,'/fixture/revoke',{deviceId:device.id})]);
  assert.equal(revoke.status,200);assert.ok([200,403].includes(loginRace.status));
  assert.equal((await get(0,'/fixture/projects',oldTicket)).status,403);
  if(loginRace.status===200)assert.equal((await get(1,'/fixture/projects',loginRace.value.ticket)).status,403);
  const second=createIdentity(),pendingEnroll=await post(0,'/fixture/enroll/begin',{deviceId:second.id,publicKey:second.pub.toString('base64url')});assert.equal(pendingEnroll.status,200);
  const body={deviceId:second.id,challengeId:pendingEnroll.value.challengeId,signature:enrollmentProof(second,pendingEnroll.value)};
  const [enrollment,logout]=await Promise.all([post(0,'/fixture/enroll/complete',body),post(1,'/fixture/logout',{})]);
  assert.equal(logout.status,200);assert.ok([200,403].includes(enrollment.status));
  assert.equal((await post(0,'/fixture/revoke',{deviceId:second.id})).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM studio_auth_devices WHERE device_id=?').get(second.id).n,enrollment.status===200?1:0);
 }finally{
  for(const w of workers)if(w.connected)w.send('stop');
  const stopped=await Promise.all(exits);assert.ok(stopped.every(x=>x.code===0),JSON.stringify(stopped));
  db.close();
  for(const suffix of ['','-journal','-wal','-shm']){const p=file+suffix;if(existsSync(p))unlinkSync(p);}
  rmdirSync(root);
 }
});
