import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,randomBytes,sign,createHash} from 'node:crypto';
import {beginRelayPairing,completeRelayPairing,relayPairingMessage,revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
import {beginRelaySession,completeRelaySession,relaySessionMessage,verifyRelaySession,revokeRelayOwnerSession} from '../lib/relay-session-authorization.ts';
const owner='a'.repeat(64),session='b'.repeat(64),otherSession='c'.repeat(64),transcript='d'.repeat(64),runtime=randomUUID();
const clock=(wall=1000,tick=wall,runtimeId=runtime)=>({runtimeId,wall,tick});
function fixture(){
 const db=new Database(':memory:'),pairId=randomUUID(),camera={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})},prompter={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})};
 for(const x of [camera,prompter])x.publicKey=x.keys.publicKey.export({format:'der',type:'spki'});
 const p=beginRelayPairing(db,owner,pairId,transcript,clock(),()=>true);
 const message=role=>relayPairingMessage(owner,pairId,p.challengeId,p.nonce,transcript,camera.deviceId,camera.publicKey,prompter.deviceId,prompter.publicKey,role);
 completeRelayPairing(db,owner,{pairId,challengeId:p.challengeId,transcriptHash:transcript,camera:{...camera,signature:sign('sha256',message('camera'),camera.keys.privateKey)},prompter:{...prompter,signature:sign('sha256',message('prompter'),prompter.keys.privateKey)}},()=>clock(1001),()=>true);
 const credential=randomBytes(32).toString('base64url'),request={pairId,deviceId:camera.deviceId,role:'camera',roomId:randomBytes(16).toString('base64url'),tokenHash:createHash('sha256').update(credential).digest('hex')};
 const make=()=>{const challenge=beginRelaySession(db,owner,session,request,clock(1010),()=>true);return {challenge,signature:sign('sha256',relaySessionMessage(owner,session,request,challenge.challengeId,challenge.nonce),camera.keys.privateKey)};};
 return {db,pairId,camera,prompter,credential,request,make};
}
test('renewal needs a fresh role and room bound device signature; exact retry grants nothing new',()=>{
 const f=fixture();try{
  const {challenge,signature}=f.make();assert.deepEqual(completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1020),()=>true),{created:true});
  assert.deepEqual(completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,signature,()=>clock(1021),()=>true),{created:false});
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,randomUUID(),signature,()=>clock(1022),()=>true),/EXPIRED/);
  assert.throws(()=>completeRelaySession(f.db,owner,session,f.request,challenge.challengeId,Buffer.alloc(64),()=>clock(1022),()=>true),/EXPIRED/);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,clock(1023),()=>true),true);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,randomBytes(32).toString('base64url'),clock(1023),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,otherSession,f.request,f.credential,clock(1023),()=>true),false);
  assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,clock(1023),()=>false),false);
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
   if(mode==='logout')assert.equal(verifyRelaySession(f.db,owner,session,f.request,f.credential,clock(1022),()=>true),false);
   else assert.throws(()=>verifyRelaySession(f.db,owner,session,f.request,f.credential,clock(1022),()=>true),/PAIR_REVOKED/);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_pair_devices').get().n,2);
  }finally{f.db.close();}
 }
});
