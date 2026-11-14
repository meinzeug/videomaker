import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,randomBytes,sign,createHash} from 'node:crypto';
import {beginRelayPairing,completeRelayPairing,relayPairingMessage,revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
import {beginRelaySession,completeRelaySession,relaySessionMessage,verifyRelaySession,revokeRelayOwnerSession,verifyRelaySessionPair,verifyRelayPeerBinding} from '../lib/relay-session-authorization.ts';
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
  const authorizedPeer=hash=>hash===otherSession;
  assert.equal(verifyRelayPeerBinding(f.db,owner,camera,()=>clock(1024),authorizedPeer),true);
  assert.equal(verifyRelayPeerBinding(f.db,owner,{...camera,credential:randomBytes(32).toString('base64url')},()=>clock(1024),authorizedPeer),false);
  assert.equal(verifyRelayPeerBinding(f.db,owner,camera,()=>clock(1024),()=>false),false);
  let checks=0;assert.equal(verifyRelayPeerBinding(f.db,owner,camera,()=>clock(1024),()=>++checks===1),false);
  assert.equal(verifyRelayPeerBinding(f.db,owner,{...camera,authorize:()=>false},()=>clock(1024),authorizedPeer),false);
  assert.equal(verifyRelayPeerBinding(f.db,owner,{...camera,request:{...camera.request,roomId:randomBytes(16).toString('base64url')}},()=>clock(1024),authorizedPeer),false);
  assert.throws(()=>verifyRelayPeerBinding(f.db,owner,camera,()=>clock(1024),()=>{throw Error('session lookup failed');}),/session lookup failed/);
  let reads=0;assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(++reads===1?1024:301011)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,{...guest,request:{...request,roomId:randomBytes(16).toString('base64url')}},()=>clock(1024)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,{...guest,authorize:()=>false},()=>clock(1024)),false);
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(301011)),false);
  revokeRelayPairing(f.db,owner,f.pairId,1025,()=>true);
  assert.throws(()=>verifyRelayPeerBinding(f.db,owner,camera,()=>clock(1026),authorizedPeer),/PAIR_REVOKED/);
  assert.throws(()=>verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(1026)),/PAIR_REVOKED/);
 }finally{f.db.close();}
});

test('a foreign runtime cannot delete another pending device challenge',()=>{
 const f=fixture();try{
  const original=f.make(),credential=randomBytes(32).toString('base64url');
  const request={...f.request,role:'prompter',deviceId:f.prompter.deviceId,tokenHash:createHash('sha256').update(credential).digest('hex')};
  const otherRuntime=randomUUID();beginRelaySession(f.db,owner,otherSession,request,()=>clock(1011,1011,otherRuntime),()=>true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_session_challenges').get().n,2);
  assert.equal(completeRelaySession(f.db,owner,session,f.request,original.challenge.challengeId,original.signature,()=>clock(1020),()=>true).created,true);
 }finally{f.db.close();}
});

test('single bearer peer check expires permanently and observes peer logout',()=>{
 for(const mode of ['expired','logout']){
  const f=fixture();try{
   const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
   const peerCredential=randomBytes(32).toString('base64url'),peerRequest={...f.request,deviceId:f.prompter.deviceId,role:'prompter',tokenHash:createHash('sha256').update(peerCredential).digest('hex')};
   const pc=beginRelaySession(f.db,owner,otherSession,peerRequest,()=>clock(1021),()=>true);
   const proof=sign('sha256',relaySessionMessage(owner,otherSession,peerRequest,pc.challengeId,pc.nonce),f.prompter.keys.privateKey);
   completeRelaySession(f.db,owner,otherSession,peerRequest,pc.challengeId,proof,()=>clock(1022),()=>true);
   const self={session,request:f.request,credential:f.credential,authorize:()=>true},peerAuth=value=>value===otherSession;
   if(mode==='expired'){
    assert.equal(verifyRelayPeerBinding(f.db,owner,self,()=>clock(301013,1030),peerAuth),false);
    assert.equal(verifyRelayPeerBinding(f.db,owner,self,()=>clock(1031,1031),peerAuth),false);
   }else{
    f.db.transaction(()=>revokeRelayOwnerSession(f.db,otherSession)).immediate();
    assert.equal(verifyRelayPeerBinding(f.db,owner,self,()=>clock(1023),peerAuth),false);
   }
  }finally{f.db.close();}
 }
});

test('single bearer check discards an expired grant even when the peer is absent',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  const self={session,request:f.request,credential:f.credential,authorize:()=>true};
  assert.equal(verifyRelayPeerBinding(f.db,owner,self,()=>clock(301011,1021),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022,1022),()=>true),false);
 }finally{f.db.close();}
});

test('single bearer check detects grant revocation or replacement during authorization',()=>{
 for(const mode of ['revoke-own','revoke-peer','replace-own','replace-peer','clock-revoke']){
  const f=fixture();try{
   const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
   const peerCredential=randomBytes(32).toString('base64url'),peerRequest={...f.request,deviceId:f.prompter.deviceId,role:'prompter',tokenHash:createHash('sha256').update(peerCredential).digest('hex')};
   const pc=beginRelaySession(f.db,owner,otherSession,peerRequest,()=>clock(1021),()=>true);
   const proof=sign('sha256',relaySessionMessage(owner,otherSession,peerRequest,pc.challengeId,pc.nonce),f.prompter.keys.privateKey);
   completeRelaySession(f.db,owner,otherSession,peerRequest,pc.challengeId,proof,()=>clock(1022),()=>true);
   const self={session,request:f.request,credential:f.credential,authorize:()=>true};let calls=0,reads=0;
   const peerAuth=()=>{if(++calls===1&&mode!=='clock-revoke'){
    const target=mode.endsWith('own')?session:otherSession;
    if(mode.startsWith('revoke'))revokeRelayOwnerSession(f.db,target);
    else f.db.prepare('UPDATE relay_session_tokens SET proof_hash=? WHERE session_hash=?').run('f'.repeat(64),target);
   }return true;};
   const now=()=>{if(++reads===2&&mode==='clock-revoke')revokeRelayOwnerSession(f.db,otherSession);return clock(1023);};
   assert.equal(verifyRelayPeerBinding(f.db,owner,self,now,peerAuth),false,mode);
  }finally{f.db.close();}
 }
});

test('begin never returns a challenge that expired while rechecking authorization',()=>{
 const f=fixture();try{
  const first=f.make().challenge;let ticks=0;
  const next=beginRelaySession(f.db,owner,session,f.request,()=>clock(++ticks===1?1020:61001),()=>true);
  assert.equal(next.created,true);assert.notEqual(next.challengeId,first.challengeId);
 }finally{f.db.close();}
});
test('a new challenge that expires before commit is rolled back',()=>{
 const f=fixture();try{
  let ticks=0;assert.throws(()=>beginRelaySession(f.db,owner,session,f.request,()=>clock(++ticks===1?1020:61011),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_session_challenges'").get(),undefined);
 }finally{f.db.close();}
});

test('an observed expired grant cannot revive after wall clock rollback',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(301011,1021),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022,1022),()=>true),false);
 }finally{f.db.close();}
});
test('an observed expired session challenge stays expired after wall clock rollback',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(61001,1021),()=>true),/EXPIRED/);
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1022,1022),()=>true),/EXPIRED/);
 }finally{f.db.close();}
});
test('an expired role grant is discarded even if the other role is absent',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  const camera={session,request:f.request,credential:f.credential,authorize:()=>true},credential=randomBytes(32).toString('base64url');
  const request={...f.request,deviceId:f.prompter.deviceId,role:'prompter',tokenHash:createHash('sha256').update(credential).digest('hex')};
  const guest={session:otherSession,request,credential,authorize:()=>true};
  assert.equal(verifyRelaySessionPair(f.db,owner,camera,guest,()=>clock(301011,1021)),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022,1022),()=>true),false);
 }finally{f.db.close();}
});

test('expiry-sensitive operations cannot be wrapped in a transaction that rolls back their tombstones',()=>{
 const f=fixture();try{
  assert.throws(()=>f.db.transaction(()=>beginRelaySession(f.db,owner,session,f.request,()=>clock(1010),()=>true)).immediate(),/NESTED_RELAY_TRANSACTION_UNSUPPORTED/);
  const {challenge,signature}=f.make();
  assert.throws(()=>f.db.transaction(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true)).immediate(),/NESTED_RELAY_TRANSACTION_UNSUPPORTED/);
  completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  assert.throws(()=>f.db.transaction(()=>verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1021),()=>true)).immediate(),/NESTED_RELAY_TRANSACTION_UNSUPPORTED/);
 }finally{f.db.close();}
});

test('a failed replacement does not delete a different still-valid pending challenge',()=>{
 const f=fixture();try{
  const first=f.make().challenge,otherRequest={...f.request,roomId:randomBytes(16).toString('base64url')};let ticks=0;
  assert.throws(()=>beginRelaySession(f.db,owner,session,otherRequest,()=>clock(++ticks===1?1020:61011),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare('SELECT challenge_id FROM relay_session_challenges WHERE pair_id=? AND role=?').get(f.pairId,'camera').challenge_id,first.challengeId);
 }finally{f.db.close();}
});

test('a different runtime cannot consume or delete a valid challenge or grant',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make(),foreign=randomUUID();
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020,1020,foreign),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_session_challenges').get().n,1);
  completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1021,1021,foreign),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,()=>clock(1022),()=>true),true);
 }finally{f.db.close();}
});

test('a foreign runtime cannot replace the same pair and role challenge',()=>{
 const f=fixture();try{
  const original=f.make(),foreign=randomUUID();
  assert.throws(()=>beginRelaySession(f.db,owner,session,f.request,()=>clock(1011,1011,foreign),()=>true),/FOREIGN_RUNTIME/);
  assert.equal(f.db.prepare('SELECT challenge_id FROM relay_session_challenges WHERE pair_id=? AND role=?').get(f.pairId,'camera').challenge_id,original.challenge.challengeId);
  assert.equal(completeRelaySession(f.db,owner,session,f.request,original.challenge.challengeId,original.signature,()=>clock(1020),()=>true).created,true);
 }finally{f.db.close();}
});
