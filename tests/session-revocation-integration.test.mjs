// Only a disposable local Next fixture; never a public server or real database.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import Database from 'better-sqlite3';
import {join} from 'node:path';
const base=process.env.SESSION_REVOCATION_TEST_SERVER;
const dataDir=process.env.SESSION_REVOCATION_TEST_DATA;
const enabled=base==='http://127.0.0.1:3332'&&dataDir==='/tmp/videomaker-auth-revocation-fixture'&&process.env.SESSION_REVOCATION_TEST_ALLOW_WRITES==='1';
test('logout invalidates a copied cookie but preserves other sessions and fails visibly on DB errors',{skip:!enabled,timeout:60000},async()=>{
 const secret='isolated-testing-secret-value-at-least-32-bytes';
 const request=(path,{method='GET',cookie='',body}={})=>fetch(base+path,{method,headers:{origin:base,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 async function login(){const r=await request('/api/login',{method:'POST',body:{password:'camera-local-test'}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 const legacyBody=`${Date.now()+600000}.${randomBytes(18).toString('base64url')}`;
 const legacyCookie=`kontrakurs_session=${legacyBody}.${createHmac('sha256',secret).update(legacyBody).digest('base64url')}`;
 const other=await login();
 assert.equal((await request('/api/projects',{cookie:legacyCookie})).status,200);
 assert.equal((await request('/api/logout',{method:'POST',cookie:legacyCookie})).status,200);
 assert.equal((await request('/api/projects',{cookie:legacyCookie})).status,401);
 assert.equal((await request('/api/projects',{cookie:other})).status,200);
 const db=new Database(join(dataDir,'videomaker.sqlite'));
 try{
  // A deferred foreign key fails the server connection's COMMIT, not merely
  // the INSERT, after all in-transaction camera credential deletes have run.
  db.exec(`CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY);
   CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
   CREATE TRIGGER fixture_fail_revocation AFTER INSERT ON auth_session_revocations BEGIN INSERT INTO fixture_child VALUES(1); END;`);
  const failed=await request('/api/logout',{method:'POST',cookie:other});
  assert.equal(failed.status,500);
  assert.doesNotMatch(failed.headers.get('set-cookie')||'',/kontrakurs_session=/);
  assert.equal((await request('/api/projects',{cookie:other})).status,200);
 }finally{db.exec('DROP TRIGGER IF EXISTS fixture_fail_revocation; DROP TABLE IF EXISTS fixture_child; DROP TABLE IF EXISTS fixture_parent');db.close();}
 assert.equal((await request('/api/logout',{method:'POST',cookie:other})).status,200);
 assert.equal((await request('/api/projects',{cookie:other})).status,401);
});
test('logout invalidates the session camera ticket and device can reauthenticate with its key',{skip:!enabled,timeout:60000},async()=>{
 let cookie='';const deviceId=randomUUID(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const spki=publicKey.export({type:'spki',format:'der'});
 const request=(path,body,extra={})=>fetch(base+path,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 async function login(){const r=await request('/api/login',{password:'camera-local-test'});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];}
 async function prove(action){
  let r=await request('/api/camera-devices/pairing/challenge',{deviceId,action});assert.equal(r.status,200);const c=await r.json();
  const payload=action==='register'?spki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
  const message=`videomaker-camera-device-auth/v2\n${deviceId}\n${c.challengeId}\n${c.challenge}\n${action}\n${hash}\n`;
  r=await request('/api/camera-devices/pairing/complete',{deviceId,action,challengeId:c.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),privateKey).toString('base64url')});assert.equal(r.status,200);return r.json();
 }
 let sequence=0;
 const heartbeat=()=>({id:deviceId,sequence:++sequence,name:'Testkamera',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[]});
 await login();await prove('register');const old=(await prove('session')).ticket;
 assert.equal((await request('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':old})).status,200);
 assert.equal((await request('/api/logout',{})).status,200);
 assert.equal((await request('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':old})).status,403);
 assert.equal((await request('/api/camera-devices/pairing/challenge',{deviceId,action:'session'})).status,403);
 await login();
 assert.equal((await request('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':old})).status,403);
 const fresh=(await prove('session')).ticket;assert.notEqual(fresh,old);
 assert.equal((await request('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':fresh})).status,200);
});
