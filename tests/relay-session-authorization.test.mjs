import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,randomBytes,sign,createHash} from 'node:crypto';
import {beginRelayPairing,completeRelayPairing,relayPairingMessage,revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
import {beginRelaySession,completeRelaySession,relaySessionMessage,verifyRelaySession,revokeRelayOwnerSession,verifyRelaySessionPair} from '../lib/relay-session-authorization.ts';
const owner='a'.repeat(64),session='b'.repeat(64),otherSession='c'.repeat(64),transcript='d'.repeat(64),runtime=randomUUID();
const clock=(wall=1000,tick=wall,runtimeId=runtime)=>({runtimeId,wall,tick});
function fixture(){
 const db=new Database(':memory:'),pairId=randomUUID(),camera={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})},prompter={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})};
 for(const x of [camera,prompter])x.publicKey=x.keys.publicKey.export({format:'der',type:'spki'});
 const p=beginRelayPairing(db,owner,pairId,transcript,()=>clock(),()=>true);
 const message=role=>relayPairingMessage(owner,pairId,p.challengeId,p.nonce,transcript,camera.deviceId,camera.publicKey,prompter.deviceId,prompter.publicKey,role);
 completeRelayPairing(db,owner,{pairId,challengeId:p.challengeId,transcriptHash:transcript,camera:{...camera,signature:sign('sha256',message('camera'),camera.keys.privateKey)},prompter:{...prompter,signature:sign('sha256',message('prompter'),prompter.keys.privateKey)}},()=>clock(1001),()=>true);
 const credential=randomBytes(32).toString('base64url'),request={pairId,deviceId:camera.deviceId,role:'camera',roomId:randomBytes(16).toString('base64url'),tokenHash:createHash('sha256').update(credential).digest('hex')};
 const make=()=>{const challenge=beginRelaySession(db,owner,session,request,()=>clock(1010),()=>true);return {challenge,signature:sign('sha256',relaySessionMessage(owner,session,request,challenge.challengeId,challenge.nonce),camera.keys.privateKey)};};
 return {db,pairId,camera,prompter,credential,request,make};
}
test('renewal needs a fresh role and room bound device signature; exact retry grants nothing new',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();assert.deepEqual(completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true),{created:true});
  assert.deepEqual(completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1021),()=>true),{created:false});
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,randomUUID(),signature,()=>clock(1022),()=>true),/EXPIRED/);
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,Buffer.alloc(64),()=>clock(1022),()=>true),/EXPIRED/);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1023),()=>true),true);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,randomBytes(32).toString('base64url'),()=>clock(1023),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,otherSession,f.request,f.credential,()=>clock(1023),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1023),()=>false),false);
 }finally{f.db.close();}
});
test('wrong role, substituted room, expired challenge or logout cannot issue a grant',()=>{
 for(const mode of ['role','room','expired','logout','false']){
  const f=fixture();try{
   const {challenge,signature}=f.make(),request={...f.request};if(mode==='role')request.role='prompter';if(mode==='room')request.roomId=randomBytes(16).toString('base64url');
   let calls=0;const now=()=>mode==='expired'?clock(61001):clock(1020),authorize=()=>{calls++;if(mode==='false')return false;if(mode==='logout'&&calls>1)return false;return true;};
   assert.throws(()=>completeRelaySession(f.db,owner,session,request,challenge.challengeId,signature,now,authorize));
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_session_tokens').get().n,0);
  }finally{f.db.close();}
 }
});
test('logout and durable pair/device revocation invalidate live grants without erasing trust',()=>{
 for(const mode of ['logout','pair','device']){
  const f=fixture();try{
   const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
   if(mode==='logout')f.db.transaction(()=>revokeRelayOwnerSession(f.db,session)).immediate();
   if(mode==='pair')revokeRelayPairing(f.db,owner,f.pairId,1021,()=>true);
   if(mode==='device')revokeRelayDevice(f.db,owner,f.camera.deviceId,1021,()=>true);
   if(mode==='logout')assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022),()=>true),false);
   else assert.throws(()=>verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022),()=>true),/PAIR_REVOKED/);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_pair_devices').get().n,2);
  }finally{f.db.close();}
 }
});

test('session transcript matches the Android role and room test vector',()=>{
 const pairId='00000000-0000-4000-8000-000000000001',challengeId='00000000-0000-4000-8000-000000000002',deviceId='00000000-0000-4000-8000-000000000004',nonce='A'.repeat(43),roomId='A'.repeat(22),tokenHash='d'.repeat(64);
 const expected=`videomaker-relay-session/v1\n${owner}\n${session}\n${pairId}\nprompter\n${deviceId}\n${roomId}\n${tokenHash}\n${challengeId}\n${nonce}\n`;
 assert.equal(relaySessionMessage(owner,session,{pairId,role:'prompter',deviceId,roomId,tokenHash},challengeId,nonce).toString(),expected);
});

test('ticket expiry during authorization or the final transaction recheck fails closed',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  let phase=0;assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(phase++===0?1021:301011),()=>true),false);
  let calls=0;assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(calls++===0?1021:301011),()=>true),/EXPIRED/);
  let checks=0;assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1021),()=>++checks===1),false);
 }finally{f.db.close();}
});
test('signing work that crosses challenge expiry never issues a grant',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();let checks=0;
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(checks++===0?1020:61001),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_session_tokens').get().n,0);
 }finally{f.db.close();}
});

test('expiry during the final authorization check cannot return success',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  let ticks=0;assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(++ticks<3?1021:301011),()=>true),false);
  ticks=0;assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(++ticks<3?1021:301011),()=>true),/EXPIRED/);
 }finally{f.db.close();}
});

test('both different devices must prove fresh authorization for the same room',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  const camera={session,request:f.request,credential:f.credential,authorize:()=>true};
  const credential=randomBytes(32).toString('base64url'),request={...f.request,deviceId:f.prompter.deviceId,role:'prompter',tokenHash:createHash('sha256').update(credential).digest('hex')};
  const guest={session:otherSession,request,credential,authorize:()=>true};
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(1021)),false);
  const pc=beginRelaySession(f.db,owner,otherSession,request,()=>clock(1022),()=>true);
  const proof=sign('sha256',relaySessionMessage(owner,otherSession,request,pc.challengeId,pc.nonce),f.prompter.keys.privateKey);
  completeRelaySession(f.db,owner,otherSession,request,pc.challengeId,proof,()=>clock(1023),()=>true);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(1024)),true);
  let reads=0;assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(++reads===1?1024:301011)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,{...guest,request:{...request,roomId:randomBytes(16).toString('base64url')}},()=>clock(1024)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,{...guest,authorize:()=>false},()=>clock(1024)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(301011)),false);
  revokeRelayPairing(f.db,owner,f.pairId,1025,()=>true);
  assert.throws(()=>verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(1026)),/PAIR_REVOKED/);
 }finally{f.db.close();}
});

test('a foreign runtime cannot delete another pending device challenge',()=>{
 const f=fixture();try{
  const original=f.make(),credential=randomBytes(32).toString('base64url');
  const request={...f.request,role:'prompter',deviceId:f.prompter.deviceId,tokenHash:createHash('sha256').update(credential).digest('hex')};
  beginRelaySession(f.db,owner,otherSession,request,()=>clock(1011,1011,randomUUID()),()=>true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_session_challenges').get().n,2);
  assert.equal(completeRelaySession(f.db,owner,session,f.request,original.challenge.challengeId,original.signature,()=>clock(1020),()=>true).created,true);
 }finally{f.db.close();}
});
