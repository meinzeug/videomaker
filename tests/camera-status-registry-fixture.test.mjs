import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {statusProofTranscript} from '../experiments/web-camera-status/status-proof.mjs';
import {initStatusRegistryFixture,openStatusFixture,acceptStatusFixture,readStatusFixture,transitionChannelFixture} from '../experiments/web-camera-status/fixture-status-registry.mjs';
process.env.NODE_ENV='test';process.env.WEB_STATUS_REGISTRY_FIXTURE='1';
const owner='a'.repeat(64),browser='b'.repeat(64),device='c'.repeat(64);
const b={owner,browserSession:browser,deviceSession:device,cameraId:'00000000-0000-0000-0000-000000000001',prompterId:'00000000-0000-0000-0000-000000000002',pairEpoch:'00000000-0000-0000-0000-000000000003'};
const s={revision:42,phase:'recording',recordingId:'00000000-0000-0000-0000-000000000005',projectKnown:true,projectId:'00000000-0000-0000-0000-000000000006',front:false};
function seed(db,pub){initStatusRegistryFixture(db);db.prepare('INSERT INTO status_fixture_sessions VALUES(?,?,?,?,0)').run(browser,'browser',owner,null);db.prepare('INSERT INTO status_fixture_sessions VALUES(?,?,?,?,0)').run(device,'device',owner,b.prompterId);db.prepare('INSERT INTO status_fixture_pairs VALUES(?,?,?,?,?,0,1,1)').run(owner,b.prompterId,b.cameraId,b.pairEpoch,pub);}
function fixture(){const db=new Database(':memory:'),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});seed(db,keys.publicKey.export({format:'der',type:'spki'}));let time=1_000_000;const clock=()=>time;const open=()=>openStatusFixture(db,b,clock);const signed=(q,key=keys.privateKey,state=s)=>sign('sha256',statusProofTranscript({...b,requestId:q.requestId,nonce:q.nonce},state),key);return {db,keys,clock,open,signed,set:n=>time=n};}

test('known status requires signed snapshot from server-bound camera key',()=>{
 const f=fixture();try{const q=f.open();assert.equal(q.state,'pending');
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,f.signed(q,other.privateKey),f.clock),{state:'unknown'});
  assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'unknown'});
  const sig=f.signed(q);assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,sig,f.clock),{state:'complete'});
  assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,sig,f.clock),{state:'unknown'});
  assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'known',status:s});
 }finally{f.db.close();}
});
test('separate browser/device sessions and pair identifiers are mandatory',()=>{
 const f=fixture();try{
  for(const x of [{...b,browserSession:device},{...b,deviceSession:browser},{...b,owner:'d'.repeat(64)},{...b,pairEpoch:randomUUID()},{...b,prompterId:b.cameraId},{...b,cameraId:randomUUID()}])assert.deepEqual(openStatusFixture(f.db,x,f.clock),{state:'unknown'});
  f.db.prepare('UPDATE status_fixture_sessions SET device_id=? WHERE session_hash=?').run(randomUUID(),device);
  assert.deepEqual(f.open(),{state:'unknown'});
 }finally{f.db.close();}
});
test('revocation of either session or pair hides an already completed result',()=>{
 for(const sql of ["UPDATE status_fixture_sessions SET revoked=1 WHERE kind='browser'","UPDATE status_fixture_sessions SET revoked=1 WHERE kind='device'","UPDATE status_fixture_pairs SET revoked=1"]){const f=fixture();try{const q=f.open();assert.equal(acceptStatusFixture(f.db,b,q.requestId,s,f.signed(q),f.clock).state,'complete');f.db.exec(sql);assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'unknown'});}finally{f.db.close();}}
});
test('expired or clock-rollback snapshot cannot reappear',()=>{
 const f=fixture();try{const q=f.open();assert.equal(acceptStatusFixture(f.db,b,q.requestId,s,f.signed(q),f.clock).state,'complete');f.set(1_010_000);assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'unknown'});f.set(1_000_001);assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'unknown'});}finally{f.db.close();}
});
test('public-key replacement is rejected during and after verification',()=>{
 const f=fixture();try{
  const q=f.open(),sig=f.signed(q),other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'});let calls=0;
  const mutating=()=>{if(++calls===2)f.db.prepare('UPDATE status_fixture_pairs SET camera_public_key=?').run(other);return f.clock();};
  assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,sig,mutating),{state:'unknown'});
  f.db.prepare('UPDATE status_fixture_pairs SET camera_public_key=?').run(f.keys.publicKey.export({format:'der',type:'spki'}));
  assert.equal(acceptStatusFixture(f.db,b,q.requestId,s,sig,f.clock).state,'complete');
  f.db.prepare('UPDATE status_fixture_pairs SET camera_public_key=?').run(other);
  assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'unknown'});
 }finally{f.db.close();}
});
test('reentrant revocation or request substitution after proof fails closed',()=>{
 for(const mutate of [db=>db.prepare('UPDATE status_fixture_sessions SET revoked=1 WHERE session_hash=?').run(browser),db=>db.prepare("UPDATE status_fixture_requests SET nonce='fake'").run()]){const f=fixture();try{const q=f.open();let calls=0;const clock=()=>{if(++calls===2)mutate(f.db);return f.clock();};assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,f.signed(q),clock),{state:'unknown'});}finally{f.db.close();}}
});
test('verified immutable snapshot is the only value stored',()=>{
 const f=fixture();try{const q=f.open(),sig=f.signed(q);const proxy=new Proxy({...s},{get(target,key){if(key==='phase')return 'paused';return target[key];}});
  assert.equal(acceptStatusFixture(f.db,b,q.requestId,proxy,sig,f.clock).state,'complete');assert.deepEqual(readStatusFixture(f.db,b,q.requestId,f.clock),{state:'known',status:s});
 }finally{f.db.close();}
});

async function runRace(dbFile,modeA,modeB,args){
 const {fork}=await import('node:child_process'),worker=new URL('./fixtures/status-registry-race.mjs',import.meta.url),children=[];
 try{
  const start=mode=>new Promise((resolve,reject)=>{const child=fork(worker,[dbFile,mode,JSON.stringify(args)],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);child.once('error',reject);child.once('message',m=>m==='ready'?resolve(child):reject(Error('fixture failed')));});
  const [a,c]=await Promise.all([start(modeA),start(modeB)]);
  const run=child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.send('go');});
  return await Promise.all([run(a),run(c)]);
 }finally{for(const child of children)if(child.connected)child.kill();}
}

test('two processes cannot consume the same signed status twice',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'status-fixture-race-'));let db;
 try{const f=fixture(),q=f.open(),sig=f.signed(q),file=join(dir,'fixture.sqlite');await f.db.backup(file);f.db.close();
  const results=await runRace(file,'accept','accept',{binding:b,id:q.requestId,status:s,signature:sig.toString('base64')});
  assert.deepEqual(results.map(x=>x.result?.state).sort(),['complete','unknown']);
  db=new Database(file);assert.deepEqual(readStatusFixture(db,b,q.requestId,()=>1_000_002),{state:'known',status:s});
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent pair revocation never leaves readable known status after commit',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'status-fixture-revoke-'));let db;
 try{const f=fixture(),q=f.open(),sig=f.signed(q),file=join(dir,'fixture.sqlite');await f.db.backup(file);f.db.close();
  const results=await runRace(file,'accept','revoke',{binding:b,id:q.requestId,status:s,signature:sig.toString('base64')});
  assert.ok(['complete','unknown'].includes(results[0].result?.state));assert.equal(results[1].result,1);
  db=new Database(file);assert.deepEqual(readStatusFixture(db,b,q.requestId,()=>1_000_002),{state:'unknown'});
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});


test('old proof and result stay unknown after disconnect and same-pair reconnect',()=>{
 const f=fixture();try{
  const old=f.open(),sig=f.signed(old);assert.equal(acceptStatusFixture(f.db,b,old.requestId,s,sig,f.clock).state,'complete');
  assert.equal(transitionChannelFixture(f.db,b.cameraId,b.pairEpoch,false),true);
  assert.deepEqual(readStatusFixture(f.db,b,old.requestId,f.clock),{state:'unknown'});
  assert.equal(transitionChannelFixture(f.db,b.cameraId,b.pairEpoch,true),true);
  assert.deepEqual(readStatusFixture(f.db,b,old.requestId,f.clock),{state:'unknown'});
  assert.deepEqual(acceptStatusFixture(f.db,b,old.requestId,s,sig,f.clock),{state:'unknown'});
  const fresh=f.open();assert.equal(acceptStatusFixture(f.db,b,fresh.requestId,s,f.signed(fresh),f.clock).state,'complete');
 }finally{f.db.close();}
});
test('pending proof from disconnected channel is not accepted after reconnect',()=>{
 const f=fixture();try{const q=f.open(),sig=f.signed(q);
  transitionChannelFixture(f.db,b.cameraId,b.pairEpoch,false);transitionChannelFixture(f.db,b.cameraId,b.pairEpoch,true);
  assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,sig,f.clock),{state:'unknown'});
 }finally{f.db.close();}
});

test('invalid or unavailable clock fails closed',()=>{
 const f=fixture();try{const q=f.open();assert.deepEqual(acceptStatusFixture(f.db,b,q.requestId,s,f.signed(q),()=>{throw Error('clock');}),{state:'unknown'});assert.deepEqual(readStatusFixture(f.db,b,q.requestId,()=>Number.NaN),{state:'unknown'});}finally{f.db.close();}
});
