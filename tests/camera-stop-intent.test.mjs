import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ensureCameraRemoteSchema} from '../lib/camera-remote-store.ts';
import {CAMERA_STOP_INTENT_SCHEMA,cameraStopIntentId,reserveCameraStopSlot,requestCameraStopIntent,deliverCameraStopIntent} from '../lib/camera-stop-intent.ts';
const clock={runtimeId:randomUUID(),wall:100000,tick:100000};
const owner='a'.repeat(64);
function fixture(){
 const db=new Database(':memory:');ensureCameraRemoteSchema(db);db.exec(CAMERA_STOP_INTENT_SCHEMA);
 const id=randomUUID(),take=randomUUID();
 db.prepare('INSERT INTO camera_remote_devices(id,owner_hash,sequence,name,phase,recording_id,project_id,updated_at,runtime_id,updated_tick) VALUES(?,?,1,?,?,?,?,?,?,?)').run(id,owner,'Kamera','recording',take,null,clock.wall,clock.runtimeId,clock.tick);
 reserveCameraStopSlot(db,id);return {db,id,take};
}
test('a bounded preallocated slot repeats one recording-bound stop independently of command quota and ACK',()=>{
 const {db,id,take}=fixture();const intent=requestCameraStopIntent(db,id,take,clock);
 assert.equal(intent.created,true);assert.equal(intent.observed,false);
 for(let i=0;i<200;i++){
  assert.equal(requestCameraStopIntent(db,id,take,clock).id,intent.id);
  const delivery=deliverCameraStopIntent(db,id,'recording',take,clock.wall+i);
  assert.equal(delivery.id,intent.id);assert.equal(delivery.recordingId,take);assert.ok(delivery.remainingMs>0);
 }
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_stop_intents').get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_commands').get().n,0);
 assert.equal(deliverCameraStopIntent(db,id,'recording',randomUUID(),clock.wall),null);
 assert.equal(db.prepare('SELECT observed_at FROM camera_stop_intents').get().observed_at,null);
 assert.equal(deliverCameraStopIntent(db,id,'finalizing',take,clock.wall+1),null);
 assert.deepEqual(requestCameraStopIntent(db,id,take,clock),{id:intent.id,created:false,observed:true});
 db.close();
});
test('a stop for a locally started preparing take survives expired deliveries and cannot stop another take',()=>{
 const {db,id,take}=fixture();db.prepare("UPDATE camera_remote_devices SET sequence=sequence+1,phase='preparing' WHERE id=?").run(id);
 const intent=requestCameraStopIntent(db,id,take,clock);
 assert.equal(deliverCameraStopIntent(db,id,'preparing',take,clock.wall).id,intent.id);
 assert.equal(deliverCameraStopIntent(db,id,'preparing',take,clock.wall+500000).id,intent.id);
 const other=randomUUID();db.prepare("UPDATE camera_remote_devices SET sequence=sequence+1,recording_id=? WHERE id=?").run(other,id);
 assert.throws(()=>requestCameraStopIntent(db,id,other,clock),/früherer Stopp/);
 assert.equal(deliverCameraStopIntent(db,id,'error',other,clock.wall+1),null);
 assert.equal(db.prepare('SELECT observed_at FROM camera_stop_intents').get().observed_at,null);
 deliverCameraStopIntent(db,id,'error',take,clock.wall+2);
 const next=requestCameraStopIntent(db,id,other,clock);
 assert.notEqual(next.id,intent.id);assert.equal(next.created,true);
 assert.throws(()=>requestCameraStopIntent(db,id,take,clock),/bestätigt/);
 db.close();
});
test('unknown, unreserved and stale devices fail closed',()=>{
 const {db,id,take}=fixture();
 assert.throws(()=>reserveCameraStopSlot(db,randomUUID()),/registriert/);
 assert.throws(()=>requestCameraStopIntent(db,id,take,{...clock,tick:clock.tick+10000}),/erreichbar/);
 assert.throws(()=>requestCameraStopIntent(db,id,take,{...clock,runtimeId:randomUUID()}),/erreichbar/);
 db.prepare('DELETE FROM camera_stop_intents WHERE device_id=?').run(id);
 assert.throws(()=>requestCameraStopIntent(db,id,take,clock),/reservierten/);
 db.close();
});
test('pending intent survives a database reopen and the reserved slot cannot be consumed by another take',()=>{
 const folder=mkdtempSync(join(tmpdir(),'camera-stop-'));
 try{
  const path=join(folder,'fixture.db'),id=randomUUID(),take=randomUUID();let db=new Database(path);
  ensureCameraRemoteSchema(db);db.exec(CAMERA_STOP_INTENT_SCHEMA);
  db.prepare('INSERT INTO camera_remote_devices(id,owner_hash,sequence,name,phase,recording_id,project_id,updated_at,runtime_id,updated_tick) VALUES(?,?,1,?,?,?,?,?,?,?)').run(id,owner,'Kamera','recording',take,null,clock.wall,clock.runtimeId,clock.tick);
  reserveCameraStopSlot(db,id);const original=requestCameraStopIntent(db,id,take,clock);db.close();
  db=new Database(path);
  assert.equal(deliverCameraStopIntent(db,id,'recording',take,clock.wall+20).id,original.id);
  assert.equal(requestCameraStopIntent(db,id,take,clock).id,original.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_stop_intents').get().n,1);
  db.close();
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('legacy contaminated STOP is repaired on delivery, then survives retries and preserves the take',()=>{
 for (const type of ['camera_switch','record_pause']) {
  const {db,id,take}=fixture();
  try {
   const old=cameraStopIntentId(id,take);
   db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick,result) VALUES(?,?,?,?,?,?,?,?,?,'accepted')").run(old,id,old,type,clock.wall,clock.wall+9990,clock.runtimeId,clock.tick,clock.tick+9990);
   db.prepare('UPDATE camera_stop_intents SET recording_id=?,intent_id=? WHERE device_id=?').run(take,old,id);
   const delivery=deliverCameraStopIntent(db,id,'recording',take,clock.wall);
   assert.notEqual(delivery.id,old);assert.equal(delivery.recordingId,take);
   assert.equal(requestCameraStopIntent(db,id,take,clock).id,delivery.id);
   assert.equal(deliverCameraStopIntent(db,id,'recording',take,clock.wall+1).id,delivery.id);
   assert.deepEqual(db.prepare('SELECT old_intent_id,new_intent_id FROM camera_stop_id_repairs').get(),{old_intent_id:old,new_intent_id:delivery.id});
   assert.throws(()=>db.prepare('DELETE FROM camera_stop_id_repairs').run(),/retained/);
  } finally {db.close();}
 }
});
test('failed legacy STOP repair rolls back slot and audit rather than delivering the colliding command',()=>{
 const {db,id,take}=fixture();
 try {
  const old=cameraStopIntentId(id,take);
  db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick,result) VALUES(?,?,?,'camera_switch',?,?,?,?,?,'accepted')").run(old,id,old,clock.wall,clock.wall+9990,clock.runtimeId,clock.tick,clock.tick+9990);
  db.prepare('UPDATE camera_stop_intents SET recording_id=?,intent_id=? WHERE device_id=?').run(take,old,id);
  db.exec("CREATE TRIGGER fail_stop_repair BEFORE UPDATE ON camera_stop_intents BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  assert.throws(()=>deliverCameraStopIntent(db,id,'recording',take,clock.wall),/synthetic write failure/);
  assert.equal(db.prepare('SELECT intent_id FROM camera_stop_intents').get().intent_id,old);
  assert.equal(db.prepare('SELECT count(*) n FROM camera_stop_id_repairs').get().n,0);
  db.exec('DROP TRIGGER fail_stop_repair');
  assert.notEqual(deliverCameraStopIntent(db,id,'recording',take,clock.wall).id,old);
 } finally {db.close();}
});

test('repaired legacy stop and audit survive reopening the database',()=>{
 const folder=mkdtempSync(join(tmpdir(),'camera-stop-repair-'));let db;
 try {
  const path=join(folder,'fixture.db'),id=randomUUID(),take=randomUUID(),old=cameraStopIntentId(id,take);
  db=new Database(path);ensureCameraRemoteSchema(db);db.exec(CAMERA_STOP_INTENT_SCHEMA);
  db.prepare('INSERT INTO camera_remote_devices(id,owner_hash,sequence,name,phase,recording_id,project_id,updated_at,runtime_id,updated_tick) VALUES(?,?,1,?,?,?,?,?,?,?)').run(id,owner,'Kamera','recording',take,null,clock.wall,clock.runtimeId,clock.tick);
  reserveCameraStopSlot(db,id);
  db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick,result) VALUES(?,?,?,'camera_switch',?,?,?,?,?,'accepted')").run(old,id,old,clock.wall,clock.wall+9990,clock.runtimeId,clock.tick,clock.tick+9990);
  db.prepare('UPDATE camera_stop_intents SET recording_id=?,intent_id=? WHERE device_id=?').run(take,old,id);
  const repaired=deliverCameraStopIntent(db,id,'recording',take,clock.wall);db.close();
  db=new Database(path);
  assert.equal(requestCameraStopIntent(db,id,take,clock).id,repaired.id);
  assert.equal(deliverCameraStopIntent(db,id,'recording',take,clock.wall+1).id,repaired.id);
  assert.equal(db.prepare('SELECT count(*) n FROM camera_stop_id_repairs').get().n,1);
 } finally {db?.close();rmSync(folder,{recursive:true,force:true});}
});
