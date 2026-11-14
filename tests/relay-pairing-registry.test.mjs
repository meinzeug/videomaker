import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {beginRelayPairing,completeRelayPairing,relayPairingMessage,revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
const owner='a'.repeat(64),other='b'.repeat(64),transcript='c'.repeat(64),runtime=randomUUID();
const time=(wall=1000,tick=wall,runtimeId=runtime)=>({runtimeId,wall,tick});
function fixture(){
 const db=new Database(':memory:'),pairId=randomUUID(),camera={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})},prompter={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})};
 for(const side of [camera,prompter])side.publicKey=side.keys.publicKey.export({format:'der',type:'spki'});
 const prepare=(challenge)=>{const message=role=>relayPairingMessage(owner,pairId,challenge.challengeId,challenge.nonce,transcript,camera.deviceId,camera.publicKey,prompter.deviceId,prompter.publicKey,role);return {pairId,challengeId:challenge.challengeId,transcriptHash:transcript,camera:{deviceId:camera.deviceId,publicKey:camera.publicKey,signature:sign('sha256',message('camera'),camera.keys.privateKey)},prompter:{deviceId:prompter.deviceId,publicKey:prompter.publicKey,signature:sign('sha256',message('prompter'),prompter.keys.privateKey)}};};
 return {db,pairId,camera,prompter,prepare};
}
test('both identities prove possession and retry of a completed pairing is idempotent',()=>{
 const f=fixture();try{
  const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true);
  assert.deepEqual(beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(1001),()=>true),challenge);
  const input=f.prepare(challenge);assert.deepEqual(completeRelayPairing(f.db,owner,input,()=>time(1002),()=>true),{pairId:f.pairId,created:true});
  assert.deepEqual(completeRelayPairing(f.db,owner,input,()=>time(1003),()=>true),{pairId:f.pairId,created:false});
  assert.throws(()=>completeRelayPairing(f.db,owner,{...input,challengeId:randomUUID()},()=>time(1003),()=>true),/PROOF/);
  assert.throws(()=>completeRelayPairing(f.db,owner,{...input,camera:{...input.camera,signature:Buffer.alloc(64)}},()=>time(1003),()=>true),/PROOF/);
  assert.throws(()=>completeRelayPairing(f.db,owner,{...input,prompter:{...input.prompter,signature:Buffer.alloc(64)}},()=>time(1003),()=>true),/PROOF/);
  assert.throws(()=>completeRelayPairing(f.db,other,input,()=>time(1003),()=>true),/PROOF|CONFLICT/);
  assert.throws(()=>f.db.prepare('DELETE FROM relay_pair_links WHERE pair_id=?').run(f.pairId));
  assert.throws(()=>f.db.prepare('UPDATE relay_pair_devices SET public_key=? WHERE device_id=?').run(f.prompter.publicKey,f.camera.deviceId));
 }finally{f.db.close();}
});
test('wrong proof, different roles, expiry and revoked session never create a pairing',()=>{
 for(const mode of ['bad_signature','role_swap','expiry','restart','logout']){
  const f=fixture();try{
   const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);
   if(mode==='bad_signature')input.camera.signature=Buffer.alloc(64);
   if(mode==='role_swap')[input.camera.signature,input.prompter.signature]=[input.prompter.signature,input.camera.signature];
   let calls=0;const clock=()=>{calls++;return mode==='expiry'?time(61000):mode==='restart'?time(1001,1001,randomUUID()):time(1001);};
   const auth=()=>{if(mode==='logout'&&calls>0)throw Error('UNAUTHORIZED');return true;};
   assert.throws(()=>completeRelayPairing(f.db,owner,input,clock,auth));
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,0);
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_devices').get().n,0);
  }finally{f.db.close();}
 }
});
test('revoking a pair or device is permanent, owner-bound and never removes user data',()=>{
 for(const mode of ['pair','device']){
  const f=fixture();try{
   const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);
   completeRelayPairing(f.db,owner,input,()=>time(1001),()=>true);
   assert.throws(()=>revokeRelayPairing(f.db,other,f.pairId,1002,()=>true),/MISSING/);
   if(mode==='pair')assert.equal(revokeRelayPairing(f.db,owner,f.pairId,1002,()=>true),true);
   else assert.equal(revokeRelayDevice(f.db,owner,f.camera.deviceId,1002,()=>true),true);
   assert.equal(f.db.prepare('SELECT revoked_at FROM relay_pair_links WHERE pair_id=?').get(f.pairId).revoked_at,1002);
   assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(1003),()=>true),/CONFLICT/);
   assert.throws(()=>beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(1003),()=>true),/CONFLICT/);
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_devices').get().n,2);
  }finally{f.db.close();}
 }
});

test('authorization must explicitly return true before and after proof verification',()=>{
 for(const mode of ['false','throw','late_false']){
  const f=fixture();try{
   if(mode==='false'||mode==='throw'){
    const authorization=()=>{if(mode==='throw')throw Error('UNAUTHORIZED');return false;};
    assert.throws(()=>beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),authorization),/UNAUTHORIZED/);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_pair_links'").get(),undefined);
   }else{
    const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);let checks=0;
    assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(1001),()=>++checks===1),/UNAUTHORIZED/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_pair_links').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_pair_devices').get().n,0);
   }
  }finally{f.db.close();}
 }
});

test('concurrent independent processes commit one pairing and an exact retry only',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fork}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'relay-pair-race-')),file=join(dir,'fixture.sqlite'),f=fixture();f.db.close();f.db=new Database(file,{timeout:10000});
 const children=[];
 try{
  const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);
  const serialized={...input,camera:{...input.camera,publicKey:input.camera.publicKey.toString('base64'),signature:input.camera.signature.toString('base64')},prompter:{...input.prompter,publicKey:input.prompter.publicKey.toString('base64'),signature:input.prompter.signature.toString('base64')}};
  const run=()=>new Promise((resolve,reject)=>{const child=fork('tests/fixtures/relay-pairing-race-worker.mjs',[file],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc']});children.push(child);let ready=false;child.on('message',value=>{if(value==='ready'){ready=true;resolve({child,result:new Promise((done,fail)=>{child.once('message',done);child.once('error',fail);})});}});child.once('error',reject);child.once('exit',code=>{if(!ready)reject(Error('worker exited '+code));});});
  const workers=await Promise.all([run(),run()]);workers.forEach(({child})=>child.send({owner,input:serialized,clock:time(1001)}));
  const results=await Promise.all(workers.map(x=>x.result));assert.ok(results.every(x=>x.ok));assert.deepEqual(results.map(x=>x.value.created).sort(),[false,true]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,1);
 }finally{for(const child of children)if(child.connected)child.kill();f.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('pairing transcript matches the Android role-bound test vector',()=>{
 const pair='00000000-0000-4000-8000-000000000001',challenge='00000000-0000-4000-8000-000000000002',camera='00000000-0000-4000-8000-000000000003',prompter='00000000-0000-4000-8000-000000000004',nonce='A'.repeat(43),owner='a'.repeat(64),transcript='c'.repeat(64);
 const expected=`videomaker-relay-pair/v1\n${owner}\n${pair}\n${challenge}\n${nonce}\n${transcript}\n${camera}\n1da57ee8fb4654e9343dffaa2f1925e7158a3a07dd61bb2fa411741a5097f664\n${prompter}\nff6d15f7d14324b2dac093e20f6b5562de82494d758ffa1890ab486b1e3b4b62\ncamera\n`;
 assert.equal(relayPairingMessage(owner,pair,challenge,nonce,transcript,camera,Buffer.from('camera-key'),prompter,Buffer.from('prompter-key'),'camera').toString(),expected);
});

test('pairing challenge expiry during the final commit preparation rolls back everything',()=>{
 const f=fixture();try{
  const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);let reads=0;
  assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(++reads<3?1001:61001),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_links').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_devices').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_challenges').get().n,0);
 }finally{f.db.close();}
});

test('a different runtime cannot delete an unrelated pending pairing challenge',()=>{
 const f=fixture();try{
  const first=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true);
  const otherRuntime=randomUUID();beginRelayPairing(f.db,owner,randomUUID(),transcript,()=>time(1001,1001,otherRuntime),()=>true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM relay_pair_challenges').get().n,2);
  assert.equal(completeRelayPairing(f.db,owner,f.prepare(first),()=>time(1002),()=>true).created,true);
 }finally{f.db.close();}
});

test('an observed expired pairing challenge cannot revive after wall clock rollback',()=>{
 const f=fixture();try{
  const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge);
  assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(61000,1001),()=>true),/EXPIRED/);
  assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(1002,1002),()=>true),/EXPIRED/);
 }finally{f.db.close();}
});

test('a foreign runtime cannot consume an otherwise valid pairing challenge',()=>{
 const f=fixture();try{
  const challenge=beginRelayPairing(f.db,owner,f.pairId,transcript,()=>time(),()=>true),input=f.prepare(challenge),foreign=randomUUID();
  assert.throws(()=>completeRelayPairing(f.db,owner,input,()=>time(1001,1001,foreign),()=>true),/EXPIRED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_pair_challenges').get().n,1);
  assert.equal(completeRelayPairing(f.db,owner,input,()=>time(1002),()=>true).created,true);
 }finally{f.db.close();}
});
