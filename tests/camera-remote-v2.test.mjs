import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cameraStopIntentId} from '../lib/camera-stop-intent.ts';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,parseCameraRequest,queueCameraRequest,receiveCameraHeartbeat,listCameraDevices} from '../lib/camera-remote-store.ts';
const runtime=randomUUID(),device=randomUUID(),project=randomUUID(),recording=randomUUID(),owner='a'.repeat(64);
let seq=0;const clock=t=>({runtimeId:runtime,wall:t,tick:t});
const beat=(phase='idle',paused=null,ack=[])=>parseCameraHeartbeat({id:device,sequence:++seq,name:'Testkamera',capability:'remote-record-v3',phase,paused,cameraFront:false,cameraCanSwitch:phase==='idle',recordingId:phase==='idle'?null:recording,projectId:phase==='idle'?null:project,ack});
const cmd=(type,patch={})=>parseCameraRequest({id:randomUUID(),type,recordingId:recording,projectId:type==='record_start'?project:null,...patch});
function fixture(){
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
 const start=cmd('record_start');queueCameraRequest(db,device,start,clock(1010));receiveCameraHeartbeat(db,beat(),clock(1020),owner,undefined,true);
 receiveCameraHeartbeat(db,beat('recording',false,[{id:start.id,result:'accepted'}]),clock(1030),owner,undefined,true);return db;
}
test('v3 telemetry requires an authenticated device and a real paused state',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 assert.throws(()=>receiveCameraHeartbeat(db,beat(),clock(100),owner),/Gerätenachweis/);
 assert.throws(()=>beat('recording',null));assert.throws(()=>beat('idle',true));
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_devices').get().n,0);db.close();
});
test('GET capability is the exact authenticated current heartbeat, never stale or inferred',()=>{
 const db=fixture();try{
  assert.equal(listCameraDevices(db,clock(1031)).devices[0].capability,'remote-record-v3');
  const v4=parseCameraHeartbeat({...beat('recording',false),capability:'remote-record-v4'});
  receiveCameraHeartbeat(db,v4,clock(1040),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1041)).devices[0].capability,'remote-record-v4');
  const pause=cmd('record_pause');
  assert.equal(queueCameraRequest(db,device,pause,clock(1042)).created,true);
  assert.equal(receiveCameraHeartbeat(db,parseCameraHeartbeat({...beat('recording',false),capability:'remote-record-v4'}),clock(1050),owner,undefined,true)[0].id,pause.id);
  db.prepare('UPDATE camera_remote_reported_capabilities SET sequence=sequence-1 WHERE device_id=?').run(device);
  assert.equal(listCameraDevices(db,clock(1051)).devices[0].capability,null);
  receiveCameraHeartbeat(db,beat('recording',false),clock(1060),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1061)).devices[0].capability,'remote-record-v3');
 }finally{db.close();}
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
  const id=randomUUID(),change=cmd('camera_switch',{id,recordingId:id,cameraFrom:false});
  assert.equal(queueCameraRequest(db,device,change,clock(1010)).created,true);
  assert.equal(receiveCameraHeartbeat(db,beat(),clock(1020),owner,undefined,true)[0].type,'camera_switch');
  const ack=beat('idle',null,[{id,result:'accepted'}]);
  receiveCameraHeartbeat(db,{...ack,cameraFront:true},clock(1030),owner,undefined,true);
  assert.equal(listCameraDevices(db,clock(1031)).devices[0].cameraFront,true);
  assert.equal(queueCameraRequest(db,device,change,clock(1032)).created,false);
  assert.throws(()=>parseCameraRequest({...change,recordingId:randomUUID()}),/Kameraauswahl/);
  receiveCameraHeartbeat(db,{...beat(),cameraCanSwitch:false},clock(1040),owner,undefined,true);
  const second=randomUUID();assert.throws(()=>queueCameraRequest(db,device,cmd('camera_switch',{id:second,recordingId:second,cameraFrom:true}),clock(1050)),/nicht bereit/);
 }finally{db.close();}
});
test('a queued camera switch prevents a competing recording start',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 try{
  receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
  const id=randomUUID();queueCameraRequest(db,device,cmd('camera_switch',{id,recordingId:id,cameraFrom:false}),clock(1010));
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

test('a stale switch is rejected before delivery and cannot toggle a locally changed camera back',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 try{
  receiveCameraHeartbeat(db,beat(),clock(1000),owner,undefined,true);
  const id=randomUUID(),change=cmd('camera_switch',{id,recordingId:id,cameraFrom:false});queueCameraRequest(db,device,change,clock(1010));
  assert.deepEqual(receiveCameraHeartbeat(db,{...beat(),cameraFront:true},clock(1020),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(id).result,'rejected');
 }finally{db.close();}
});

test('legacy v1 remains compatible and cannot receive v2 controls or claim v2 state',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 try{
  const legacy=()=>parseCameraHeartbeat({id:device,sequence:++seq,name:'Legacy',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[]});
  const parsed=legacy();assert.equal(parsed.paused,null);assert.equal(parsed.cameraFront,null);assert.equal(parsed.cameraCanSwitch,false);
  assert.deepEqual(receiveCameraHeartbeat(db,parsed,clock(1000),owner,undefined,true),[]);
  const id=randomUUID();assert.throws(()=>queueCameraRequest(db,device,cmd('camera_switch',{id,recordingId:id,cameraFrom:false}),clock(1010)),/nicht erreichbar|nicht bereit/);
  const v2=beat();assert.deepEqual(receiveCameraHeartbeat(db,v2,clock(1020),owner,undefined,true),[]);
  assert.equal(listCameraDevices(db,clock(1021)).devices[0].cameraCanSwitch,true);
  assert.deepEqual(receiveCameraHeartbeat(db,legacy(),clock(1030),owner,undefined,true),[]);
  assert.equal(listCameraDevices(db,clock(1031)).devices[0].cameraCanSwitch,false);
  const afterDowngrade=randomUUID();assert.throws(()=>queueCameraRequest(db,device,cmd('camera_switch',{id:afterDowngrade,recordingId:afterDowngrade,cameraFrom:false}),clock(1040)),/nicht erreichbar|nicht bereit/);
 }finally{db.close();}
});

test('late delivered ACK cannot be overwritten by duplicates or unrelated ACKs',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  assert.equal(receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true)[0].id,pause.id);
  // The server deadline passed, but a delivered device decision may arrive late.
  receiveCameraHeartbeat(db,beat('recording',true,[{id:pause.id,result:'accepted'}]),clock(11031),owner,undefined,true);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'accepted');
  receiveCameraHeartbeat(db,beat('recording',true,[{id:pause.id,result:'rejected'},{id:randomUUID(),result:'accepted'}]),clock(11032),owner,undefined,true);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'accepted');
 }finally{db.close();}
});

test('shared heartbeat and delivery examples match versioned request rules',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/camera-v1-v3-contract.json',import.meta.url),'utf8'));
 assert.deepEqual(fixture.heartbeats.map(value=>parseCameraHeartbeat(value).capability),['remote-record-v1','remote-record-v2','remote-record-v3']);
 assert.deepEqual(fixture.commands.map(value=>parseCameraRequest(['record_pause','record_resume'].includes(value.type)?{...value,projectId:null}:value).type),['record_start','record_pause','record_resume','record_stop','camera_switch']);
 assert.ok(fixture.commands.filter(value=>['record_pause','record_resume'].includes(value.type)).every(value=>typeof value.projectId==='string'));
});

test('version and action fields are literal strings, not string-coercible arrays',()=>{
 const normal=beat();
 assert.throws(()=>parseCameraHeartbeat({...normal,capability:['remote-record-v2']}),/Ungültige/);
 assert.throws(()=>parseCameraHeartbeat({...normal,capability:['remote-record-v3']}),/Ungültige/);
 assert.throws(()=>parseCameraHeartbeat({...normal,capability:['remote-record-v1']}),/Ungültige/);
 assert.throws(()=>parseCameraRequest({id:randomUUID(),type:['record_pause'],recordingId:recording,projectId:null}),/Ungültiger/);
});

test('v1 extra fields remain tolerated without acquiring v2 capability',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 try{
  const parsed=parseCameraHeartbeat({id:device,sequence:++seq,name:'Legacy',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,paused:false,cameraFront:true,cameraCanSwitch:true,ack:[]});
  assert.equal(parsed.paused,null);assert.equal(parsed.cameraFront,null);assert.equal(parsed.cameraCanSwitch,false);
  receiveCameraHeartbeat(db,parsed,clock(1000),owner,undefined,true);
  const id=randomUUID();assert.throws(()=>queueCameraRequest(db,device,cmd('camera_switch',{id,recordingId:id,cameraFrom:true}),clock(1010)),/nicht erreichbar|nicht bereit/);
 }finally{db.close();}
});

test('queued pause and resume are bound to the original live take and project at delivery',()=>{
 for(const [action,initialPaused] of [['record_pause',false],['record_resume',true]]){
  const db=fixture();try{
   if(initialPaused)receiveCameraHeartbeat(db,beat('recording',true),clock(1035),owner,undefined,true);
   const command=cmd(action);queueCameraRequest(db,device,command,clock(1040));
   const otherProject=randomUUID();
   assert.deepEqual(receiveCameraHeartbeat(db,{...beat('recording',initialPaused),projectId:otherProject},clock(1050),owner,undefined,true),[]);
   assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(command.id).result,'rejected');
   assert.deepEqual(receiveCameraHeartbeat(db,beat('recording',initialPaused),clock(1060),owner,undefined,true),[]);
  }finally{db.close();}
 }
});

test('dequeued pause includes its immutable expected project and an open claim',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  const delivered=receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true);
  assert.equal(delivered[0].projectId,project);
  assert.throws(()=>db.prepare('UPDATE camera_remote_control_projects SET project_id=? WHERE id=?').run(randomUUID(),pause.id),/cannot be changed/);
 }finally{db.close();}
});

test('project change after delivery does not falsely claim the delivered command was rejected',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  assert.equal(receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true)[0].id,pause.id);
  const otherProject=randomUUID();assert.deepEqual(receiveCameraHeartbeat(db,{...beat('recording',false),projectId:otherProject},clock(1060),owner,undefined,true),[]);
  const row=db.prepare('SELECT result,delivered_at FROM camera_remote_controls WHERE id=?').get(pause.id);
  assert.equal(row.result,'queued');assert.equal(row.delivered_at,1050);
 }finally{db.close();}
});

test('legacy queued v2 control without a project proof is never delivered or silently revived',()=>{
 const db=fixture();try{
  const old=cmd('record_pause');
  db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick) VALUES(?,?,?,'record_pause',?,?,?,?,?)").run(old.id,device,recording,1040,11030,runtime,1040,11030);
  assert.throws(()=>queueCameraRequest(db,device,old,clock(1041)),/ohne gesicherte Projektbindung/);
  assert.deepEqual(receiveCameraHeartbeat(db,beat('recording',false),clock(1050),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(old.id).result,'rejected');
 }finally{db.close();}
});

test('non-stop command IDs cannot occupy the global STOP UUIDv8 namespace',()=>{
 const stopShaped=cameraStopIntentId(device,randomUUID());
 for(const type of ['record_start','record_pause','record_resume','camera_switch']){
  assert.throws(()=>parseCameraRequest({id:stopShaped,type,recordingId:type==='camera_switch'?stopShaped:recording,projectId:type==='record_start'?project:null,...(type==='camera_switch'?{cameraFrom:false}:{})}),/Befehls-ID.*reserviert/);
 }
});

test('historical switch or pause ID before start cannot collide with the later stable STOP',()=>{
 for(const oldType of ['camera_switch','record_pause']){
  const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
  try{
   receiveCameraHeartbeat(db,beat(),clock(900),owner,undefined,true);
   const old=cameraStopIntentId(device,recording);
   db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick,result) VALUES(?,?,?,?,?,?,?,?,?,'accepted')").run(old,device,old,oldType,910,10900,runtime,910,10900);
   const start=cmd('record_start');queueCameraRequest(db,device,start,clock(920));
   assert.equal(receiveCameraHeartbeat(db,beat(),clock(930),owner,undefined,true)[0].id,start.id);
   receiveCameraHeartbeat(db,beat('recording',false,[{id:start.id,result:'accepted'}]),clock(940),owner,undefined,true);
   const request=cmd('record_stop');const first=queueCameraRequest(db,device,request,clock(950));assert.notEqual(first.id,old);
   const retry=queueCameraRequest(db,device,request,clock(951));assert.equal(retry.id,first.id);assert.equal(retry.created,false);
   const delivered=receiveCameraHeartbeat(db,beat('recording',false),clock(960),owner,undefined,true);
   assert.equal(delivered[0].type,'record_stop');assert.equal(delivered[0].id,first.id);assert.equal(delivered[0].recordingId,recording);
  }finally{db.close();}
 }
});

test('mixed v2 and v3 devices never receive project-bound controls as v2',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  const oldApp={...beat('recording',false),capability:'remote-record-v2'};
  assert.deepEqual(receiveCameraHeartbeat(db,oldApp,clock(1050),owner,undefined,true),[]);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_resume'),clock(1051)),/Kameraprotokoll v3/);
  const nowNew=beat('recording',false),delivery=receiveCameraHeartbeat(db,nowNew,clock(1060),owner,undefined,true);
  assert.equal(delivery[0].id,pause.id);assert.equal(delivery[0].projectId,project);
 }finally{db.close();}
});

test('internal queue also rejects a forged STOP-shaped non-stop ID',()=>{
 const db=fixture();try{
  const fake={id:cameraStopIntentId(device,randomUUID()),type:'record_pause',recordingId:recording,projectId:null,cameraFrom:null};
  assert.throws(()=>queueCameraRequest(db,device,fake,clock(1040)),/Befehls-ID.*reserviert/);
 }finally{db.close();}
});

test('v4 uncertain receipt freezes new actions, resists late ACK and still delivers STOP',()=>{
 const db=fixture();try{
  const v4=(phase,paused,ack=[])=>parseCameraHeartbeat({...beat(phase,paused),capability:'remote-record-v4',ack});
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  assert.equal(receiveCameraHeartbeat(db,v4('recording',false),clock(1050),owner,undefined,true)[0].id,pause.id);
  assert.deepEqual(receiveCameraHeartbeat(db,v4('recording',false,[{id:pause.id,result:'uncertain'}]),clock(1060),owner,undefined,true),[]);
  assert.equal(listCameraDevices(db,clock(1061)).devices[0].uncertain,true);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_pause'),clock(1062)),/ungeklärt/);
  assert.deepEqual(receiveCameraHeartbeat(db,v4('recording',false,[{id:pause.id,result:'accepted'}]),clock(1070),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'queued');
  queueCameraRequest(db,device,cmd('record_stop'),clock(1080));
  assert.equal(receiveCameraHeartbeat(db,v4('recording',false),clock(1090),owner,undefined,true)[0].type,'record_stop');
 }finally{db.close();}
});

test('uncertain requires v4 and cannot be forged for an undelivered command',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  assert.throws(()=>parseCameraHeartbeat({...beat('recording',false),ack:[{id:pause.id,result:'uncertain'}]}),/Ungültig/);
  const v4=parseCameraHeartbeat({...beat('recording',false),capability:'remote-record-v4',ack:[{id:pause.id,result:'uncertain'}]});
  assert.equal(receiveCameraHeartbeat(db,v4,clock(1050),owner,undefined,true)[0].id,pause.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_uncertain').get().n,0);
 }finally{db.close();}
});

test('v4 uncertain decisions survive process restart and cannot be replaced or erased',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'camera-v4-'));let db=fixture();
 try {
  const v4=(ack=[])=>parseCameraHeartbeat({...beat('recording',false),capability:'remote-record-v4',ack});
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  receiveCameraHeartbeat(db,v4(),clock(1050),owner,undefined,true);
  receiveCameraHeartbeat(db,v4([{id:pause.id,result:'uncertain'}]),clock(1060),owner,undefined,true);
  await db.backup(join(dir,'snapshot.db'));db.close();db=new Database(join(dir,'snapshot.db'));ensureCameraRemoteSchema(db);
  assert.equal(listCameraDevices(db,clock(1061)).devices[0].uncertain,true);
  assert.throws(()=>db.prepare('DELETE FROM camera_remote_uncertain').run(),/retained/);
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO camera_remote_uncertain VALUES(?,?,?)').run(pause.id,device,1100),/exists/);
  assert.deepEqual(receiveCameraHeartbeat(db,v4([{id:pause.id,result:'uncertain'}]),clock(1070),owner,undefined,true),[]);
  assert.throws(()=>queueCameraRequest(db,device,cmd('record_pause'),clock(1080)),/ungeklärt/);
  queueCameraRequest(db,device,cmd('record_stop'),clock(1090));
  assert.equal(receiveCameraHeartbeat(db,v4(),clock(1100),owner,undefined,true)[0].type,'record_stop');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v4 START enqueue acknowledges only executor queueing and is never delivered again',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 try{
  const v4=(phase='idle',paused=null,ack=[])=>parseCameraHeartbeat({...beat(phase,paused),capability:'remote-record-v4',ack});
  receiveCameraHeartbeat(db,v4(),clock(1000),owner,undefined,true);
  const start=cmd('record_start');queueCameraRequest(db,device,start,clock(1010));
  assert.equal(receiveCameraHeartbeat(db,v4(),clock(1020),owner,undefined,true)[0].id,start.id);
  receiveCameraHeartbeat(db,v4('idle',null,[{id:start.id,result:'accepted'}]),clock(1021),owner,undefined,true);
  assert.equal(db.prepare('SELECT result FROM camera_remote_commands WHERE id=?').get(start.id).result,'queued');
  assert.deepEqual(receiveCameraHeartbeat(db,v4('idle',null,[{id:start.id,result:'enqueued'}]),clock(1030),owner,undefined,true),[]);
  const listing=listCameraDevices(db,clock(1031)).devices[0];assert.equal(listing.lastCommand.result,'enqueued');assert.equal(listing.lastCommand.receiptCapability,'remote-record-v4');assert.equal(listing.phase,'idle');
  assert.deepEqual(receiveCameraHeartbeat(db,v4('idle',null,[{id:start.id,result:'accepted'}]),clock(1040),owner,undefined,true),[]);
  assert.equal(listCameraDevices(db,clock(1041)).devices[0].lastCommand.result,'enqueued');
  receiveCameraHeartbeat(db,v4('recording',false),clock(1050),owner,undefined,true);
  assert.equal(queueCameraRequest(db,device,cmd('record_pause'),clock(1051)).created,true);
  queueCameraRequest(db,device,cmd('record_stop'),clock(1060));
  assert.equal(receiveCameraHeartbeat(db,v4('recording',false),clock(1070),owner,undefined,true)[0].type,'record_stop');
 }finally{db.close();}
});

test('a delivered v4 command cannot acquire a weaker v3 receipt or be redelivered to v3',()=>{
 const db=fixture();try{
  const pause=cmd('record_pause');queueCameraRequest(db,device,pause,clock(1040));
  const v4=(ack=[])=>parseCameraHeartbeat({...beat('recording',false),capability:'remote-record-v4',ack});
  assert.equal(receiveCameraHeartbeat(db,v4(),clock(1050),owner,undefined,true)[0].id,pause.id);
  assert.deepEqual(receiveCameraHeartbeat(db,beat('recording',false,[{id:pause.id,result:'accepted'}]),clock(1060),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(pause.id).result,'queued');
  assert.deepEqual(receiveCameraHeartbeat(db,v4([{id:pause.id,result:'uncertain'}]),clock(1070),owner,undefined,true),[]);
  assert.equal(listCameraDevices(db,clock(1071)).devices[0].uncertain,true);
 }finally{db.close();}
});

test('historical delivery without a persisted capability is never rebound or acknowledged',()=>{
 const db=fixture();try{
  const old=cmd('record_pause');
  db.prepare("INSERT INTO camera_remote_controls(id,device_id,recording_id,type,created_at,expires_at,runtime_id,created_tick,expires_tick,delivered_at) VALUES(?,?,?,'record_pause',?,?,?,?,?,?)").run(old.id,device,recording,1040,11030,runtime,1040,11030,1050);
  db.prepare('INSERT INTO camera_remote_control_projects(id,project_id) VALUES(?,?)').run(old.id,project);
  assert.deepEqual(receiveCameraHeartbeat(db,beat('recording',false,[{id:old.id,result:'accepted'}]),clock(1060),owner,undefined,true),[]);
  assert.equal(db.prepare('SELECT result FROM camera_remote_controls WHERE id=?').get(old.id).result,'queued');
  assert.equal(db.prepare('SELECT count(*) n FROM camera_remote_delivery_caps WHERE id=?').get(old.id).n,0);
 }finally{db.close();}
});
