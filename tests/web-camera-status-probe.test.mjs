import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {initStatusProbes,beginStatusProbe,deliverStatusProbe,completeStatusProbe,readStatusProbe} from '../experiments/web-camera-status/probe.mjs';
process.env.NODE_ENV='test';process.env.WEB_CAMERA_STATUS_FIXTURE='1';
function fixture(){const db=new Database(':memory:');initStatusProbes(db);const identity={owner:'a'.repeat(64),browserSession:'b'.repeat(64),deviceSession:'c'.repeat(64),prompterId:randomUUID(),cameraId:randomUUID(),pairEpoch:randomUUID()},boot=randomUUID();let wall=1000,tick=1000,allowed=true;
 return {db,identity,clock:()=>({boot,wall,tick}),auth:()=>allowed,setClock:(w,t=w)=>{wall=w;tick=t;},logout:()=>{allowed=false;}};}
const snap=()=>({phase:'recording',recordingId:randomUUID(),front:false});
test('only exact sessions and pair can deliver and read a correlated status; no browser bearer',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);assert.deepEqual(deliverStatusProbe(f.db,f.identity,id,f.clock,f.auth),{id,state:'delivered',pairEpoch:f.identity.pairEpoch});
  assert.deepEqual(deliverStatusProbe(f.db,f.identity,id,f.clock,f.auth),{id,state:'uncertain'});
  const value=snap();assert.throws(()=>completeStatusProbe(f.db,{...f.identity,pairEpoch:randomUUID()},id,value,f.clock,f.auth,()=>true));
  assert.throws(()=>completeStatusProbe(f.db,f.identity,randomUUID(),value,f.clock,f.auth,()=>true));
  assert.deepEqual(completeStatusProbe(f.db,f.identity,id,value,f.clock,f.auth,()=>true),{id,state:'complete'});
  const result=readStatusProbe(f.db,f.identity,id,f.clock,f.auth);assert.deepEqual(result,{id,state:'complete',status:value});assert.equal('ticket' in result,false);
  assert.throws(()=>readStatusProbe(f.db,{...f.identity,browserSession:'d'.repeat(64)},id,f.clock,f.auth));
  assert.throws(()=>completeStatusProbe(f.db,f.identity,id,value,f.clock,f.auth,()=>true));
 }finally{f.db.close();}
});
test('unverified camera response, logout and wrong device do not leak a result',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);deliverStatusProbe(f.db,f.identity,id,f.clock,f.auth);
  assert.throws(()=>completeStatusProbe(f.db,f.identity,id,snap(),f.clock,f.auth,()=>false));
  assert.throws(()=>readStatusProbe(f.db,{...f.identity,deviceSession:'d'.repeat(64)},id,f.clock,f.auth));f.logout();
  assert.throws(()=>completeStatusProbe(f.db,f.identity,id,snap(),f.clock,f.auth,()=>true));assert.throws(()=>readStatusProbe(f.db,f.identity,id,f.clock,f.auth));
 }finally{f.db.close();}
});
test('expired request stays expired after wall-clock rollback',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);deliverStatusProbe(f.db,f.identity,id,f.clock,f.auth);f.setClock(11000);
  assert.equal(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).state,'expired');f.setClock(1000);assert.equal(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).state,'expired');
 }finally{f.db.close();}
});
test('late authorization rollback never delivers and deadline crossing expires',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);let calls=0;const auth=()=>++calls<4;
  assert.throws(()=>deliverStatusProbe(f.db,f.identity,id,f.clock,auth));assert.equal(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).state,'queued');
  let times=0;const crossing=()=>{times++;return {...f.clock(),wall:times===1?1000:11000,tick:times===1?1000:11000};};
  assert.equal(deliverStatusProbe(f.db,f.identity,id,crossing,f.auth).state,'expired');
 }finally{f.db.close();}
});
test('concurrent query is fenced per camera and other pair cannot inspect it',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);assert.throws(()=>beginStatusProbe(f.db,{...f.identity,pairEpoch:randomUUID()},f.clock,f.auth));
  assert.throws(()=>deliverStatusProbe(f.db,{...f.identity,cameraId:randomUUID()},id,f.clock,f.auth));
  assert.throws(()=>beginStatusProbe(f.db,{...f.identity,cameraId:f.identity.prompterId},f.clock,f.auth));
 }finally{f.db.close();}
});
test('reentrant callback cannot forge completion or stale browser result',()=>{
 const f=fixture();try{const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);deliverStatusProbe(f.db,f.identity,id,f.clock,f.auth);
  const tamper=()=>{f.db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=?").run(id);return true;};
  assert.throws(()=>completeStatusProbe(f.db,f.identity,id,snap(),f.clock,f.auth,tamper));
  assert.equal(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).state,'delivered');
  const value=snap();completeStatusProbe(f.db,f.identity,id,value,f.clock,f.auth,()=>true);
  let calls=0;const auth=()=>{if(++calls===1)f.db.prepare("UPDATE web_camera_status_probe_fixture SET result='{}' WHERE id=?").run(id);return true;};
  assert.throws(()=>readStatusProbe(f.db,f.identity,id,f.clock,auth));assert.deepEqual(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).status,value);
 }finally{f.db.close();}
});
test('reentrant creation or delivery changes cannot commit a forged transition',()=>{
 const f=fixture();try{let calls=0;const tamperCreate=()=>{if(++calls===4)f.db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired'").run();return true;};
  assert.throws(()=>beginStatusProbe(f.db,f.identity,f.clock,tamperCreate));assert.equal(f.db.prepare('SELECT count(*) n FROM web_camera_status_probe_fixture').get().n,0);
  const {id}=beginStatusProbe(f.db,f.identity,f.clock,f.auth);calls=0;const tamperDelivery=()=>{if(++calls===4)f.db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=?").run(id);return true;};
  assert.throws(()=>deliverStatusProbe(f.db,f.identity,id,f.clock,tamperDelivery));assert.equal(readStatusProbe(f.db,f.identity,id,f.clock,f.auth).state,'queued');
 }finally{f.db.close();}
});
test('production cannot enable fixture',()=>{
 const f=fixture();try{process.env.NODE_ENV='production';assert.throws(()=>beginStatusProbe(f.db,f.identity,f.clock,f.auth));}finally{process.env.NODE_ENV='test';f.db.close();}
});
