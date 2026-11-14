import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ensureCameraRemoteSchema} from '../lib/camera-remote-store.ts';
import {CAMERA_STOP_INTENT_SCHEMA,reserveCameraStopSlot,requestCameraStopIntent,deliverCameraStopIntent} from '../lib/camera-stop-intent.ts';
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
