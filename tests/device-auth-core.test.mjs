import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fixture} from './fixtures/relay-delivery-fixture.mjs';
import {revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
import {initializeDeviceAuthFixture,reconnectTranscript,beginDeviceReconnect,completeDeviceReconnect,deviceRequestTranscript,authorizeDeviceRequest} from '../experiments/device-auth/core.mjs';

process.env.NODE_ENV='test';process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE='1';
const digest=value=>createHash('sha256').update(value).digest('hex');
const challenge=()=>randomBytes(32).toString('hex');
const authorize=(f,request)=>{
 const {method,path,bodySha256,sessionCredential,requestNonce,signature}=request;
 return authorizeDeviceRequest(f.db,{sessionCredential,requestNonce,signature},{method,path,bodySha256},f.clock);
};
function setup(database){
 const f=fixture(database),runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id;
 initializeDeviceAuthFixture(f.db);let wall=1023,tick=1023;const clock=()=>({runtimeId,wall,tick});
 const begin=(device=f.camera,clientChallenge=challenge())=>({clientChallenge,...beginDeviceReconnect(f.db,{deviceId:device.deviceId,pairId:f.camera.participant.request.pairId,clientChallenge},clock)});
 const signed=(attempt,device=f.camera)=>sign('sha256',reconnectTranscript(attempt),device.keys.privateKey);
 const complete=(attempt,signature=signed(attempt))=>completeDeviceReconnect(f.db,{attemptId:attempt.attemptId,clientChallenge:attempt.clientChallenge,signature},clock);
 const request=(sessionCredential,nonce=challenge(),device=f.camera,changes={})=>{
  const fields={ownerHash:f.owner,deviceId:device.deviceId,pairId:f.camera.participant.request.pairId,role:device===f.camera?'camera':'prompter',sessionHash:digest(Buffer.from(sessionCredential,'base64url')),requestNonce:nonce,method:'POST',path:'/api/turn/credentials',bodySha256:digest(''),...changes};
  return {sessionCredential,requestNonce:fields.requestNonce,method:fields.method,path:fields.path,bodySha256:fields.bodySha256,signature:sign('sha256',deviceRequestTranscript(fields),device.keys.privateKey)};
 };
 return {...f,clock,begin,signed,complete,request,setTime:(a,b=a)=>{wall=a;tick=b;}};
}

test('wire transcript has independently calculated stable digest',()=>{
 const value=reconnectTranscript({ownerHash:'a'.repeat(64),deviceId:'11111111-1111-4111-8111-111111111111',pairId:'22222222-2222-4222-8222-222222222222',role:'camera',attemptId:'33333333-3333-4333-8333-333333333333',clientChallenge:'b'.repeat(64),serverNonce:'c'.repeat(64),serverRevision:42});
 assert.equal(value.length,420);assert.equal(digest(value),'b86d384caa51c46969ae42c62e72544471eab52af6aad252f658863c1d580432');
});

test('fixture mode is mandatory and foreign keys must be enabled',()=>{
 const f=setup();try{
  const before=process.env.NODE_ENV;process.env.NODE_ENV='production';assert.throws(()=>f.begin(),/FIXTURE_DISABLED/);process.env.NODE_ENV=before;
  f.db.pragma('foreign_keys=OFF');assert.throws(()=>initializeDeviceAuthFixture(f.db),/FOREIGN_KEYS_REQUIRED/);f.db.pragma('foreign_keys=ON');
 }finally{f.db.close();}
});

test('correct key consumes the challenge once and stores only the session digest',()=>{
 const f=setup();try{
  const a=f.begin(),result=f.complete(a);assert.equal(result.clientChallenge,a.clientChallenge);assert.equal(result.pairId,a.pairId);assert.equal(result.peerDeviceId,f.prompter.deviceId);assert.equal(result.peerSpkiSha256,digest(f.prompter.publicKey));assert.equal(result.revoked,false);assert.ok(result.ttlMs>0&&result.ttlMs<=59990);assert.match(result.sessionCredential,/^[A-Za-z0-9_-]{43}$/);
  const row=f.db.prepare('SELECT * FROM device_auth_sessions').get();assert.equal(row.token_hash,digest(Buffer.from(result.sessionCredential,'base64url')));assert.equal(JSON.stringify(row).includes(result.sessionCredential),false);
  assert.throws(()=>f.complete(a),/DENIED/);
 }finally{f.db.close();}
});

test('wrong key, different challenge, malformed proof and duplicate client challenge fail closed',()=>{
 const f=setup();try{
  const a=f.begin(),other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  assert.throws(()=>f.complete(a,sign('sha256',reconnectTranscript(a),other.privateKey)),/DENIED/);
  assert.throws(()=>completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge:challenge(),signature:f.signed(a)},f.clock),/DENIED/);
  assert.throws(()=>f.complete(a,Buffer.alloc(81)),/DENIED/);
  assert.throws(()=>f.begin(f.camera,a.clientChallenge));
  assert.equal(f.complete(a).revoked,false);
 }finally{f.db.close();}
});

test('challenge expires permanently even after clock rollback',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);f.setTime(1023+59990);assert.throws(()=>f.complete(a,proof),/EXPIRED/);f.setTime(1023);assert.throws(()=>f.complete(a,proof),/DENIED/);
 }finally{f.db.close();}
});

test('revocation between challenge and proof returns terminal newer revision without token',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);revokeRelayPairing(f.db,f.owner,a.pairId,1024,()=>true);const result=f.complete(a,proof);
  assert.equal(result.revoked,true);assert.ok(result.serverRevision>a.serverRevision);assert.equal(result.sessionCredential,null);assert.equal(f.db.prepare('SELECT count(*) AS n FROM device_auth_sessions').get().n,0);assert.throws(()=>f.complete(a,proof),/DENIED/);
 }finally{f.db.close();}
});

test('a device session requires a fresh signed request, and replay or tampering fails',()=>{
 const f=setup();try{
  const result=f.complete(f.begin()),request=f.request(result.sessionCredential),identity=authorize(f,request);assert.equal(identity.ownerHash,f.owner);assert.equal(identity.deviceId,f.camera.deviceId);assert.equal(identity.role,'camera');
  assert.throws(()=>authorize(f,request),/REPLAY/);
  assert.throws(()=>authorize(f,{...f.request(result.sessionCredential),path:'/api/relay/connect'}),/DENIED/);
  const differentBody=f.request(result.sessionCredential);assert.throws(()=>authorize(f,{...differentBody,bodySha256:digest('other body')}),/DENIED/);
  assert.equal(authorize(f,differentBody).deviceId,f.camera.deviceId);
  assert.throws(()=>authorize(f,{...f.request(result.sessionCredential),signature:Buffer.alloc(0)}),/DENIED/);
  assert.throws(()=>authorize(f,{...f.request(result.sessionCredential),sessionCredential:randomBytes(32).toString('base64url')}),/DENIED/);
 }finally{f.db.close();}
});

test('foreign runtime cannot delete a challenge belonging to the original runtime',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a),foreign=()=>({...f.clock(),runtimeId:randomUUID()});
  assert.throws(()=>completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge:a.clientChallenge,signature:proof},foreign),/EXPIRED/);
  assert.equal(f.complete(a,proof).revoked,false);
 }finally{f.db.close();}
});

test('request replay journal is bounded and refuses additional operations',()=>{
 const f=setup();try{
  const result=f.complete(f.begin());
  for(let i=0;i<128;i++)assert.equal(authorize(f,f.request(result.sessionCredential)).deviceId,f.camera.deviceId);
  assert.throws(()=>authorize(f,f.request(result.sessionCredential)),/CAPACITY/);
 }finally{f.db.close();}
});

test('peer-device revocation is returned only after the registered key proves possession',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);revokeRelayDevice(f.db,f.owner,f.prompter.deviceId,1024,()=>true);
  assert.throws(()=>f.complete(a,Buffer.alloc(0)),/DENIED/);
  const result=f.complete(a,proof);assert.equal(result.revoked,true);assert.equal(result.sessionCredential,null);assert.ok(result.serverRevision>a.serverRevision);
 }finally{f.db.close();}
});

test('device revocation and session expiry reject an otherwise valid request',()=>{
 for(const mode of ['revoked','expired']){
  const f=setup();try{
   const result=f.complete(f.begin()),request=f.request(result.sessionCredential);
   if(mode==='revoked')revokeRelayDevice(f.db,f.owner,f.camera.deviceId,1024,()=>true);else f.setTime(1023+59990);
   assert.throws(()=>authorize(f,request),mode==='revoked'?/DENIED/:/EXPIRED/);
   if(mode==='expired'){f.setTime(1023);assert.throws(()=>authorize(f,request),/DENIED/);}
  }finally{f.db.close();}
 }
});

test('revocation in the final clock callback never yields a usable session',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);let reads=0;
  const clock=()=>{if(++reads===3)f.db.prepare('UPDATE relay_pair_links SET revoked_at=1024 WHERE pair_id=?').run(a.pairId);return f.clock();};
  const result=completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge:a.clientChallenge,signature:proof},clock);
  assert.equal(result.revoked,true);assert.equal(result.sessionCredential,null);assert.equal(f.db.prepare('SELECT count(*) AS n FROM device_auth_sessions').get().n,0);
 }finally{f.db.close();}
});

test('a challenge removed during verification cannot issue a session',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);let reads=0;
  const clock=()=>{if(++reads===2)f.db.prepare('DELETE FROM device_auth_challenges WHERE attempt_id=?').run(a.attemptId);return f.clock();};
  assert.throws(()=>completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge:a.clientChallenge,signature:proof},clock),/DENIED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM device_auth_sessions').get().n,0);
 }finally{f.db.close();}
});

test('a session removed during proof cannot authorize a request or return a usable token',()=>{
 const f=setup();try{
  const a=f.begin(),proof=f.signed(a);let reads=0;
  const duringCompletion=()=>{if(++reads===3)f.db.prepare('DELETE FROM device_auth_sessions').run();return f.clock();};
  assert.throws(()=>completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge:a.clientChallenge,signature:proof},duringCompletion),/DENIED/);
  const result=f.complete(f.begin()),request=f.request(result.sessionCredential);reads=0;
  const duringRequest=()=>{if(++reads===2)f.db.prepare('DELETE FROM device_auth_sessions').run();return f.clock();};
  const {sessionCredential,requestNonce,signature,method,path,bodySha256}=request;
  assert.throws(()=>authorizeDeviceRequest(f.db,{sessionCredential,requestNonce,signature},{method,path,bodySha256},duringRequest),/DENIED/);
 }finally{f.db.close();}
});

test('bounded pending challenges prevent unlimited per-device issuance',()=>{
 const f=setup();try{for(let i=0;i<4;i++)f.begin();assert.throws(()=>f.begin(),/CAPACITY/);}finally{f.db.close();}
});

test('two processes cannot consume the same valid challenge twice', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-device-auth-race-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{
  const a=f.begin(),proof=f.signed(a),payload=JSON.stringify({path,attemptId:a.attemptId,clientChallenge:a.clientChallenge,signature:proof.toString('base64'),clock:f.clock()});
  const start=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/device-auth-consume-worker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});let output='';child.stdout.on('data',data=>{output+=data;});child.stdin.end(payload);return once(child,'exit').then(([code])=>({code,output}));};
  const results=await Promise.all([start(),start()]);assert.equal(results.filter(x=>x.code===0).length,1);assert.equal(results.filter(x=>x.code===2).length,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM device_auth_sessions').get().n,1);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});
