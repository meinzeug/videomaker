import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {cameraStopIntentId} from '../lib/camera-stop-intent.ts';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,parseCameraRequest,queueCameraRequest,receiveCameraHeartbeat,listCameraDevices} from '../lib/camera-remote-store.ts';
const runtime=randomUUID(),device=randomUUID(),project=randomUUID(),recording=randomUUID(),owner='a'.repeat(64);
let seq=0;const clock=t=>({runtimeId:runtime,wall:t,tick:t});
const beat=(phase='idle',paused=null,ack=[])=>parseCameraHeartbeat({id:device,sequence:++seq,name:'Testkamera',capability:'remote-record-v2',phase,paused,cameraFront:false,cameraCanSwitch:phase==='idle',recordingId:phase==='idle'?null:recording,projectId:phase==='idle'?null:project,ack});
const cmd=(type,patch={})=>parseCameraRequest({id:randomUUID(),type,recordingId:recording,projectId:type==='record_start'?project:null,...patch});
function fixture(){
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
 const start=cmd('record_start');queueCameraRequest(db,device,start,clock(1010));receiveCameraHeartbeat(db,beat(),clock(1020),owner,undefined,true);
 receiveCameraHeartbeat(db,beat('recording',false,[{id:start.id,result:'accepted'}]),clock(1030),owner,undefined,true);return db;
}
test('v2 telemetry requires an authenticated device and a real paused state',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 assert.throws(()=>receiveCameraHeartbeat(db,beat(),clock(100),owner),/Gerätenachweis/);
 assert.throws(()=>beat('recording',null));assert.throws(()=>beat('idle',true));
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_devices').get().n,0);db.close();
});
test('pause and resume are idempotent, recording-bound, acknowledged and telemetry-driven',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');assert.equal(queueCameraRequest(db,device,pause,clock(1040)).created,true);
  assert.equal(queueCameraRequest(db,device,pause,clock(1041)).created,false);
  assert.throws(()=>queueCameraRequest(db,device,{...pause,recordingId:randomUUID()},clock(1042)),/anders verwendet/);
  assert.equal(receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true)[0].id,pause.id);
  receiveCameraHeartbeat(db,beat('recording',true,[{id:pause.id,result:'accepted'}]),clock(1060),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1061)).devices[0].paused,true);
  const resume=cmd('record_resume');assert.equal(queueCameraRequest(db,device,resume,clock(1070)).created,true);
  assert.equal(receiveCameraHeartbeat(db,beat('recording',true),clock(1080),owner,undefined,true)[0].id,resume.id);
  receiveCameraHeartbeat(db,beat('recording',false,[{id:resume.id,result:'accepted'}]),clock(1090),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1091)).devices[0].paused,false);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_resume'),clock(1092)),/Aufnahmezustand/);
 }finally{db.close();}
});
test('stop always takes precedence over queued pause and conflicting ids are rejected',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_pause',{id:cameraStopIntentId(device,recording)}),clock(1041)),/Befehls-ID/);
  queueCameraRequest(db,device,cmd('record_stop'),clock(1042));
  const delivery=receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true);
  assert.equal(delivery[0].type,'record_stop');
  assert.deepEqual(receiveCameraHeartbeat(db,beat('finalizing',null),clock(1060),owner,undefined,true),[]);
 }finally{db.close();}
});
test('undelivered forged ACK cannot settle a command and expired commands are not delivered',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  const wrongDevice=randomUUID();assert.throws(()=>receiveCameraHeartbeat(db,{...beat('recording',false,[{id:pause.id,result:'accepted'}]),id:wrongDevice},clock(1041),'b'.repeat(64),undefined,false));
  const delivery=receiveCameraHeartbeat(db,beat('recording',false,[{id:pause.id,result:'accepted'}]),clock(1042),owner,undefined,true);
  assert.equal(delivery[0].id,pause.id);assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'queued');
  assert.deepEqual(receiveCameraHeartbeat(db,beat('recording',false),clock(11031),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'server_expired');
 }finally{db.close();}
});

test('reported project must match the still-existing bound web capture',()=>{
 const db=fixture();try{
  const foreign=randomUUID();
  receiveCameraHeartbeat(db,{...beat('recording',false),projectId:foreign},clock(1040),owner,undefined,true);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_pause'),clock(1050)),/Webaufnahme/);
  receiveCameraHeartbeat(db,beat('recording',false),clock(1060),owner,undefined,true);
  db.prepare('DELETE FROM projects WHERE id=?').run(project);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_pause'),clock(1070)),/Webaufnahme/);
 }finally{db.close();}
});

test('camera switch requires an idle, device-confirmed switchable camera and is not inferred from ACK',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 try{
  receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
  const id=randomUUID(),change=cmd('camera_switch',{id,recordingId:id});
  assert.equal(queueCameraRequest(db,device,change,clock(1010)).created,true);
  assert.equal(receiveCameraHeartbeat(db,beat(),clock(1020),owner,undefined,true)[0].type,'camera_switch');
  const ack=beat('idle',null,[{id,result:'accepted'}]);
  receiveCameraHeartbeat(db,{...ack,cameraFront:true},clock(1030),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1031)).devices[0].cameraFront,true);
  assert.equal(queueCameraRequest(db,device,change,clock(1032)).created,false);
  assert.throws(()=>parseCameraRequest({...change,recordingId:randomUUID()}),/Kameraauswahl/);
  receiveCameraHeartbeat(db,{...beat(),cameraCanSwitch:false},clock(1040),owner,undefined,true);
  const second=randomUUID();assert.throws(()=>queueCameraRequest(db,device,cmd('camera_switch',{id:second,recordingId:second}),clock(1050)),/nicht bereit/);
 }finally{db.close();}
});
test('a queued camera switch prevents a competing recording start',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 try{
  receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
  const id=randomUUID();queueCameraRequest(db,device,cmd('camera_switch',{id,recordingId:id}),clock(1010));
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_start'),clock(1020)),/verarbeitet bereits/);
 }finally{db.close();}
});

test('older v2 telemetry rows migrate additively without losing their existing state',()=>{
 const db=new Database(':memory:');try{
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE camera_remote_v2_state(device_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,paused INTEGER);');
  db.prepare('INSERT INTO camera_remote_v2_state VALUES(?,?,?)').run(device,4,1);
  ensureCameraRemoteSchema(db);ensureCameraRemoteSchema(db);
  assert.deepEqual(db.prepare('SELECT sequence,paused,camera_front,can_switch FROM camera_remote_v2_state WHERE device_id=?').get(device),{sequence:4,paused:1,camera_front:null,can_switch:0});
 }finally{db.close();}
});

test('an incompatible older control schema is refused without rewriting its data',()=>{
 const db=new Database(':memory:');try{
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE camera_remote_controls(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,recording_id TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('record_pause','record_resume')),result TEXT NOT NULL DEFAULT 'queued' CHECK(result IN ('queued','server_expired','accepted','duplicate','rejected','expired')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,runtime_id TEXT NOT NULL,created_tick INTEGER NOT NULL,expires_tick INTEGER NOT NULL,delivered_at INTEGER,result_at INTEGER);");
  db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick) VALUES(?,?,?,'record_pause',?,?,?,?,?)").run(randomUUID(),device,recording,1,9991,runtime,1,9991);
  assert.throws(()=>ensureCameraRemoteSchema(db),/sichere Migration/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_controls').get().n,1);
 }finally{db.close();}
});
