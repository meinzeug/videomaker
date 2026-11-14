import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fixture} from './fixtures/relay-delivery-fixture.mjs';
import {resolveRelayBrowserSession} from '../lib/relay-browser-sessions.ts';
import {revokeSession} from '../lib/session-revocations.ts';
import {beginRelayPairing,relayPairingMessage,revokeRelayPairing} from '../lib/relay-pairing-registry.ts';
import {initializeDeviceAuthFixture,beginDeviceReconnect,completeDeviceReconnect,reconnectTranscript} from '../experiments/device-auth/core.mjs';
import {initializeQrEnrollmentFixture,issueQrEnrollmentFixture,completeQrEnrollmentFixture,readQrEnrollmentReceiptFixture} from '../experiments/device-auth/qr-enrollment.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE='1';
function setup(db=new Database(':memory:')){
 db.pragma('foreign_keys=ON');const ownerHash='a'.repeat(64),sessionHash='b'.repeat(64),runtimeId=randomUUID(),pairId=randomUUID(),transcriptHash='c'.repeat(64);let time=1000,active=true;
 const clock=()=>({runtimeId,wall:time,tick:time}),authorize=(owner,session)=>active&&owner===ownerHash&&session===sessionHash;
 const challenge=beginRelayPairing(db,ownerHash,pairId,transcriptHash,clock,()=>true);initializeDeviceAuthFixture(db);initializeQrEnrollmentFixture(db);
 const device=()=>{const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {keys,deviceId:randomUUID(),publicKey:keys.publicKey.export({type:'spki',format:'der'})};};
 const camera=device(),prompter=device(),message=role=>relayPairingMessage(ownerHash,pairId,challenge.challengeId,challenge.nonce,transcriptHash,camera.deviceId,camera.publicKey,prompter.deviceId,prompter.publicKey,role);
 const input={pairId,challengeId:challenge.challengeId,transcriptHash,camera:{deviceId:camera.deviceId,publicKey:camera.publicKey,signature:sign('sha256',message('camera'),camera.keys.privateKey)},prompter:{deviceId:prompter.deviceId,publicKey:prompter.publicKey,signature:sign('sha256',message('prompter'),prompter.keys.privateKey)}};
 const issue=()=>issueQrEnrollmentFixture(db,{ownerHash,sessionHash,input},clock,authorize);
 const complete=(ticket,changes={})=>completeQrEnrollmentFixture(db,{ownerHash,sessionHash,token:ticket.token,input,...changes},clock,authorize);
 return {db,ownerHash,sessionHash,clock,input,camera,prompter,issue,complete,setTime:x=>{time=x;},logout:()=>{active=false;}};
}

test('QR proof binds both keys and live admin session, consumes once and supports reconnect',()=>{
 const f=setup();try{
  const qr=f.issue();assert.match(qr.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM device_enrollment_tickets').get()).includes(qr.token),false);
  assert.equal(f.complete(qr).created,true);assert.throws(()=>f.complete(qr));
  const clientChallenge='d'.repeat(64),a={clientChallenge,...beginDeviceReconnect(f.db,{deviceId:f.camera.deviceId,pairId:f.input.pairId,clientChallenge},f.clock)};
  const answer=completeDeviceReconnect(f.db,{attemptId:a.attemptId,clientChallenge,signature:sign('sha256',reconnectTranscript(a),f.camera.keys.privateKey)},f.clock);
  assert.equal(answer.revoked,false);assert.equal(answer.peerDeviceId,f.prompter.deviceId);assert.equal(answer.serverRevision,1);
  revokeRelayPairing(f.db,f.ownerHash,f.input.pairId,1001,()=>true);
  const b={clientChallenge:'e'.repeat(64),...beginDeviceReconnect(f.db,{deviceId:f.camera.deviceId,pairId:f.input.pairId,clientChallenge:'e'.repeat(64)},f.clock)};
  const revoked=completeDeviceReconnect(f.db,{attemptId:b.attemptId,clientChallenge:b.clientChallenge,signature:sign('sha256',reconnectTranscript(b),f.camera.keys.privateKey)},f.clock);
  assert.equal(revoked.revoked,true);assert.equal(revoked.sessionCredential,null);assert.ok(revoked.serverRevision>answer.serverRevision);
 }finally{f.db.close();}
});

test('wrong owner, login, key, role, signature and token do not consume the approval',()=>{
 const f=setup();try{
  const qr=f.issue();for(const changes of [{ownerHash:'f'.repeat(64)},{sessionHash:'f'.repeat(64)},{token:'x'.repeat(43)},{input:{...f.input,camera:f.input.prompter,prompter:f.input.camera}},{input:{...f.input,camera:{...f.input.camera,signature:Buffer.alloc(0)}}}])assert.throws(()=>f.complete(qr,changes));
  assert.equal(f.complete(qr).created,true);
 }finally{f.db.close();}
});

test('logout or lost explicit admin approval aborts atomically',()=>{
 const f=setup();try{const qr=f.issue();f.logout();assert.throws(()=>f.complete(qr));assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,0);assert.equal(f.db.prepare('SELECT consumed_at FROM device_enrollment_tickets').get().consumed_at,null);}finally{f.db.close();}
});

test('expiry consumes pending grant even if clock later moves backwards',()=>{
 const f=setup();try{const qr=f.issue();f.setTime(60000);assert.throws(()=>f.complete(qr));f.setTime(1000);assert.throws(()=>f.complete(qr));assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,0);}finally{f.db.close();}
});

test('fixture cannot be activated in production',()=>{
 const f=setup();try{process.env.NODE_ENV='production';assert.throws(()=>f.issue(),/FIXTURE_DISABLED/);}finally{process.env.NODE_ENV='test';f.db.close();}
});


test('approval is not committed when admin login expires during the transaction',()=>{
 const f=setup();try{
  const qr=f.issue();let calls=0;
  assert.throws(()=>completeQrEnrollmentFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input},f.clock,()=>++calls<3));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,0);assert.equal(f.db.prepare('SELECT consumed_at FROM device_enrollment_tickets').get().consumed_at,null);
  assert.equal(f.complete(qr).created,true);
 }finally{f.db.close();}
});

test('two processes cannot redeem the same QR approval', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-device-enrollment-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{
  const qr=f.issue(),input=structuredClone(f.input);
  for(const side of ['camera','prompter'])for(const field of ['publicKey','signature'])input[side][field]=Buffer.from(input[side][field]).toString('base64');
  const payload=JSON.stringify({path,ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input,clock:f.clock()});
  const run=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/device-enrollment-worker.mjs',import.meta.url).pathname],{stdio:['pipe','ignore','ignore']});child.stdin.end(payload);return once(child,'exit').then(([code])=>code);};
  const result=await Promise.all([run(),run()]);assert.equal(result.filter(x=>x===0).length,1);assert.equal(result.filter(x=>x===2).length,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,1);assert.notEqual(f.db.prepare('SELECT consumed_at FROM device_enrollment_tickets').get().consumed_at,null);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('pending grants have a bounded per-owner capacity',()=>{
 const f=setup();try{const tickets=Array.from({length:8},()=>f.issue());assert.throws(()=>f.issue());assert.equal(f.complete(tickets[0]).created,true);assert.throws(()=>f.issue());}finally{f.db.close();}
});

test('trusted UI approval must match the exact displayed fingerprints and pairing',()=>{
 const f=setup();try{
  let seen;const approve=(owner,session,binding)=>{seen=binding;return owner===f.ownerHash&&session===f.sessionHash&&binding.pairId===f.input.pairId&&binding.cameraId===f.camera.deviceId&&binding.prompterId===f.prompter.deviceId;};
  const qr=issueQrEnrollmentFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,input:f.input},f.clock,approve);
  assert.equal(qr.cameraFingerprint,seen.cameraHash);assert.equal(qr.prompterFingerprint,seen.prompterHash);assert.equal(Object.isFrozen(seen),true);
  assert.throws(()=>completeQrEnrollmentFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input},f.clock,()=>false));
  assert.equal(completeQrEnrollmentFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input},f.clock,approve).created,true);
 }finally{f.db.close();}
});

test('a reentrant callback cannot extend an existing approval or replace its metadata',()=>{
 const f=setup();try{
  const qr=f.issue();let calls=0;
  assert.throws(()=>completeQrEnrollmentFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input},f.clock,()=>{
   if(++calls===1)f.db.prepare('UPDATE device_enrollment_tickets SET created_wall=created_wall+1').run();return true;
  }));
  assert.equal(f.db.prepare('SELECT created_wall FROM device_enrollment_tickets').get().created_wall,1000);
  assert.equal(f.complete(qr).created,true);
 }finally{f.db.close();}
});


test('real browser-session resolver binds QR approval and rejects a completed logout',()=>{
 const f=fixture();try{
  const runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id,clock=()=>({runtimeId,wall:1023,tick:1023}),pairId=randomUUID(),transcriptHash='d'.repeat(64),sessionHash=f.camera.session;
  const auth=(owner,session,binding)=>binding.pairId===pairId&&resolveRelayBrowserSession(f.db,f.secret,owner,session,()=>1023);
  const ch=beginRelayPairing(f.db,f.owner,pairId,transcriptHash,clock,()=>resolveRelayBrowserSession(f.db,f.secret,f.owner,sessionHash,()=>1023));
  initializeDeviceAuthFixture(f.db);initializeQrEnrollmentFixture(f.db);
  const msg=role=>relayPairingMessage(f.owner,pairId,ch.challengeId,ch.nonce,transcriptHash,f.camera.deviceId,f.camera.publicKey,f.prompter.deviceId,f.prompter.publicKey,role);
  const input={pairId,challengeId:ch.challengeId,transcriptHash,camera:{deviceId:f.camera.deviceId,publicKey:f.camera.publicKey,signature:sign('sha256',msg('camera'),f.camera.keys.privateKey)},prompter:{deviceId:f.prompter.deviceId,publicKey:f.prompter.publicKey,signature:sign('sha256',msg('prompter'),f.prompter.keys.privateKey)}};
  const qr=issueQrEnrollmentFixture(f.db,{ownerHash:f.owner,sessionHash,input},clock,auth);
  revokeSession(f.db,f.secret,f.camera.cookie,1024);
  assert.throws(()=>completeQrEnrollmentFixture(f.db,{ownerHash:f.owner,sessionHash,token:qr.token,input},clock,auth));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links WHERE pair_id=?').get(pairId).n,0);
 }finally{f.db.close();}
});


test('lost completion ACK can be recovered only with matching proof and still-authorized admin',()=>{
 const f=setup();try{
  const qr=f.issue();f.complete(qr);const receipt=(changes={})=>readQrEnrollmentReceiptFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input,...changes},f.clock,(o,s)=>o===f.ownerHash&&s===f.sessionHash);
  assert.deepEqual(receipt(),{pairId:f.input.pairId,created:true});
  assert.throws(()=>receipt({input:{...f.input,camera:{...f.input.camera,signature:Buffer.alloc(4)}}}));
  assert.throws(()=>receipt({sessionHash:'f'.repeat(64)}));
  revokeRelayPairing(f.db,f.ownerHash,f.input.pairId,1001,()=>true);assert.throws(()=>receipt());
 }finally{f.db.close();}
});

test('expired completion receipts cannot revive after a clock rollback',()=>{
 const f=setup();try{
  const qr=f.issue();f.complete(qr);const receipt=()=>readQrEnrollmentReceiptFixture(f.db,{ownerHash:f.ownerHash,sessionHash:f.sessionHash,token:qr.token,input:f.input},f.clock,()=>true);
  f.setTime(60000);assert.throws(receipt);f.setTime(1000);assert.throws(receipt);
 }finally{f.db.close();}
});
