import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cameraRemoteEnabled} from '../lib/camera-remote-feature.ts';
import {parseBootUptime,cameraRemoteClock} from '../lib/camera-remote-clock.ts';
import {CAMERA_LIMITS,ensureCameraRemoteSchema,parseCameraHeartbeat,parseCameraRequest,queueCameraRequest as queue,receiveCameraHeartbeat as receive,listCameraDevices as list} from '../lib/camera-remote-store.ts';
import {cameraUploadIdFor,recordCameraVerifiedUpload,resolveCameraFailure,claimCameraProject} from '../lib/camera-project-claims.ts';
const runtime='00000000-0000-4000-8000-000000000099';
const clock=(wall,tick=wall,runtimeId=runtime)=>({wall,tick,runtimeId});
const asClock=(value)=>typeof value==='number'?clock(value):value;
const receiveCameraHeartbeat=(db,item,now,owner='a'.repeat(64),limits,deviceAuthenticated=false)=>receive(db,item,asClock(now),owner,limits,deviceAuthenticated);
const queueCameraRequest=(db,id,item,now,limits)=>queue(db,id,item,asClock(now),limits);
const listCameraDevices=(db,now,limits)=>list(db,asClock(now),limits).devices;
const setup=()=>{const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);return db;};
const deviceId='00000000-0000-4000-8000-000000000001',otherDevice='00000000-0000-4000-8000-000000000002',projectId='00000000-0000-4000-8000-000000000003',takeId='00000000-0000-4000-8000-000000000004';
let sequence=0;
const heartbeat=(patch={})=>parseCameraHeartbeat({id:deviceId,sequence:++sequence,name:'Kamera',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[],...(['ready','partial'].includes(patch.phase)?{sizeBytes:42,sha256:'a'.repeat(64)}:{}),...patch});
const start=(patch={})=>parseCameraRequest({id:randomUUID(),type:'record_start',recordingId:takeId,projectId,...patch});
test('camera routes are disabled by default and cannot be enabled in production',()=>{
 assert.equal(cameraRemoteEnabled('development',undefined),false);
 assert.equal(cameraRemoteEnabled('test',undefined),false);
 assert.equal(cameraRemoteEnabled('production','1'),false);
 assert.equal(cameraRemoteEnabled(undefined,'1'),false);
 assert.equal(cameraRemoteEnabled('development','1'),true);
 assert.equal(cameraRemoteEnabled('test','1'),true);
});
test('Linux boot-time parser is precise and fails closed on malformed input',()=>{
 assert.equal(parseBootUptime('123.45 900.12\n'),123450);
 for(const value of ['', '12.3 1.00', '-1.00 0.00', 'Infinity 0.00', '9007199254740992.00 0.00'])assert.throws(()=>parseBootUptime(value));
 if(process.platform==='linux'){const first=cameraRemoteClock(),second=cameraRemoteClock();assert.equal(first.runtimeId,second.runtimeId);assert.ok(second.tick>=first.tick);}
});
test('camera messages enforce bounded, explicitly capable sessions and valid state combinations',()=>{
 assert.equal(heartbeat({name:' Gerät '}).name,'Gerät');
 for(const patch of [{sequence:0},{capability:'none'},{name:'x'.repeat(81)},{phase:'saved'},{phase:'recording'},{phase:'idle',recordingId:takeId},{ack:[{id:takeId,result:'made_up'}]}])assert.throws(()=>heartbeat(patch));
 assert.equal(heartbeat({phase:'recording',recordingId:takeId,projectId:null}).projectId,null); // local-only take
 assert.throws(()=>start({projectId:null}));assert.throws(()=>start({type:'record_stop',projectId}));
 assert.equal(start({type:'record_stop',projectId:null}).type,'record_stop');
});
test('UUID letter case is canonicalized for camera reports, commands and acknowledgements',()=>{
 const randomId=randomUUID();const report=heartbeat({id:randomId.toUpperCase(),ack:[{id:randomId.toUpperCase(),result:'accepted'}]});
 assert.equal(report.id,randomId);assert.equal(report.ack[0].id,randomId);
 const request=start({id:randomId.toUpperCase(),recordingId:randomId.toUpperCase(),projectId:randomId.toUpperCase()});
 assert.equal(request.id,randomId);assert.equal(request.recordingId,randomId);assert.equal(request.projectId,randomId);
});
test('queue is idempotent, bound to the project and visible status comes only from actual device reports',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();assert.deepEqual(queueCameraRequest(db,deviceId,command,1100),{id:command.id,created:true,result:'queued'});
 assert.equal(queueCameraRequest(db,deviceId,command,1101).created,false);
 assert.throws(()=>queueCameraRequest(db,deviceId,{...command,projectId:randomUUID()},1102),/anders verwendet/);
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1102),/früherer Start/);
 const poll=receiveCameraHeartbeat(db,heartbeat(),1200);assert.equal(poll.length,1);assert.equal(poll[0].recordingId,takeId);assert.equal(poll[0].remainingMs,9890);
 receiveCameraHeartbeat(db,heartbeat({ack:[{id:command.id,result:'accepted'}]}),1300);
 const listed=listCameraDevices(db,1301);assert.equal(listed[0].phase,'idle');assert.equal(listed[0].lastCommand.result,'accepted'); // accepted is not recording
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1302),/früherer Start/);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId}),1400);
 assert.throws(()=>queueCameraRequest(db,deviceId,start({type:'record_stop',projectId:null,recordingId:randomUUID()}),1401),/nicht/);
 const stop=start({type:'record_stop',projectId:null});assert.equal(queueCameraRequest(db,deviceId,stop,1500).created,true);
 receiveCameraHeartbeat(db,heartbeat({phase:'finalizing',recordingId:takeId,projectId,ack:[{id:stop.id,result:'accepted'}]}),1600);
 assert.equal(listCameraDevices(db,1601)[0].phase,'finalizing');
 receiveCameraHeartbeat(db,heartbeat({phase:'ready',recordingId:takeId,projectId}),1700);
 assert.equal(listCameraDevices(db,1701)[0].phase,'ready'); // local file, not cloud
 receiveCameraHeartbeat(db,heartbeat(),1800);
 assert.equal(queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1801).created,true);
 db.close();
});
test('expired commands are not redelivered or assumed unexecuted without device evidence',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),1150)[0].id,command.id); // response may have been lost
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),11101).length,0);
 assert.equal(queueCameraRequest(db,deviceId,command,11101).result,'server_expired');
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),11102),/früherer Start/);
 receiveCameraHeartbeat(db,heartbeat({ack:[{id:command.id,result:'expired'}]}),11200);
 assert.equal(queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),11201).created,true);
 db.close();
});
test('a start known never delivered expires atomically and releases camera and project',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);
 receiveCameraHeartbeat(db,heartbeat(),11101);
 const row=listCameraDevices(db,11101)[0];assert.equal(row.lastCommand.neverDelivered,1);assert.equal(row.pendingStart,false);
 assert.notEqual(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(takeId).closed_at,null);
 receiveCameraHeartbeat(db,heartbeat({ack:[{id:command.id,result:'accepted'}]}),11101);
 assert.equal(queueCameraRequest(db,deviceId,command,11101).result,'server_expired'); // impossible forged ACK does not change proof
 assert.equal(queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),11102).created,true);
 db.close();
});
test('pre-migration commands with unknown delivery remain blocked after expiry',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);const id=randomUUID();
 db.transaction(()=>{
  db.prepare("INSERT INTO camera_remote_commands(id,device_id,type,recording_id,project_id,result,created_at,expires_at,runtime_id,created_tick,expires_tick) VALUES(?,?,'record_start',?,?,'queued',?,?,?,?,?)").run(id,deviceId,takeId,projectId,1100,11090,runtime,1100,11090);
  claimCameraProject(db,takeId,deviceId,projectId,1100);
 }).immediate();
 receiveCameraHeartbeat(db,heartbeat(),11101);const state=listCameraDevices(db,11101)[0];
 assert.equal(state.lastCommand.result,'server_expired');assert.equal(state.lastCommand.neverDelivered,0);assert.equal(state.pendingStart,true);
 assert.equal(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(takeId).closed_at,null);
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),11102),/früherer Start/);db.close();
});
test('a confirmed incomplete take can be explicitly released only when device is not recording',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);receiveCameraHeartbeat(db,heartbeat(),1150);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:command.id,result:'accepted'}]}),1200);
 assert.throws(()=>resolveCameraFailure(db,deviceId,takeId,projectId,'a'.repeat(64),clock(1201)),/laufenden/);
 receiveCameraHeartbeat(db,heartbeat({phase:'partial',recordingId:takeId,projectId}),1300);
 receiveCameraHeartbeat(db,heartbeat(),1400);
 assert.throws(()=>resolveCameraFailure(db,deviceId,takeId,randomUUID(),'a'.repeat(64),clock(1401)),/unvollständiger/);
 assert.throws(()=>resolveCameraFailure(db,deviceId,takeId,projectId,'a'.repeat(64),clock(11400)),/nicht erreichbar/);
 assert.equal(resolveCameraFailure(db,deviceId,takeId,projectId,'a'.repeat(64),clock(1402)).created,true);
 assert.equal(resolveCameraFailure(db,deviceId,takeId,projectId,'a'.repeat(64),clock(1403)).created,false);
 assert.equal(db.prepare('SELECT phase FROM camera_project_manual_resolutions WHERE recording_id=?').get(takeId).phase,'partial');
 assert.throws(()=>db.prepare('DELETE FROM camera_project_manual_resolutions').run(),/cannot be deleted/);db.close();
});
test('a ready recording cannot be manually released based on an earlier partial report',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);receiveCameraHeartbeat(db,heartbeat(),1150);
 receiveCameraHeartbeat(db,heartbeat({phase:'partial',recordingId:takeId,projectId}),1200);
 receiveCameraHeartbeat(db,heartbeat({phase:'ready',recordingId:takeId,projectId}),1300);receiveCameraHeartbeat(db,heartbeat(),1400);
 assert.throws(()=>resolveCameraFailure(db,deviceId,takeId,projectId,'a'.repeat(64),clock(1401)),/unvollständiger/);db.close();
});
test('other session cannot acknowledge a command; stale sessions and missing projects are refused',()=>{
 const db=setup();receiveCameraHeartbeat(db,heartbeat(),1000);
 assert.throws(()=>queueCameraRequest(db,deviceId,start(),1001),/Skript/);
 db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);const command=start();queueCameraRequest(db,deviceId,command,1100);
 receiveCameraHeartbeat(db,heartbeat({id:otherDevice,ack:[{id:command.id,result:'accepted'}]}),1200);
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),1300).length,1);
 assert.throws(()=>queueCameraRequest(db,otherDevice,start({recordingId:randomUUID()}),11201),/nicht erreichbar/);
 db.close();
});
test('out-of-order reports cannot resurrect an outdated recording status',()=>{
 const db=setup();const recording=heartbeat({phase:'recording',recordingId:takeId,projectId});receiveCameraHeartbeat(db,recording,1000);
 receiveCameraHeartbeat(db,heartbeat({phase:'ready',recordingId:takeId,projectId}),1100);
 assert.throws(()=>receiveCameraHeartbeat(db,recording,1200),/Veraltete/);
 assert.equal(listCameraDevices(db,1200)[0].phase,'ready');db.close();
});
test('a verified upload releases the claim even when a confirmed READY is followed by idle',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:command.id,result:'accepted'}]}),1200);
 receiveCameraHeartbeat(db,heartbeat({phase:'ready',recordingId:takeId,projectId}),1300,'a'.repeat(64),undefined,true);
 receiveCameraHeartbeat(db,heartbeat(),1400);
 const before=db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(takeId);assert.equal(before.closed_at,null);
 db.transaction(()=>recordCameraVerifiedUpload(db,takeId,projectId,cameraUploadIdFor(takeId,projectId),'a'.repeat(64),42,1500)).immediate();
 assert.equal(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(takeId).closed_at,1500);db.close();
});
test('a partial file remains distinct from a complete local recording',()=>{
 const db=setup();receiveCameraHeartbeat(db,heartbeat({phase:'partial',recordingId:takeId,projectId:null}),1000);
 assert.equal(listCameraDevices(db,1001)[0].phase,'partial');db.close();
});
test('a different authenticated session cannot impersonate a registered camera',()=>{
 const db=setup();receiveCameraHeartbeat(db,heartbeat(),1000);
 assert.throws(()=>receiveCameraHeartbeat(db,heartbeat(),1100,'b'.repeat(64)),/Kamerasitzung/);
 const rowid=db.prepare('SELECT rowid FROM camera_remote_devices WHERE id=?').get(deviceId).rowid;
 const replace=db.prepare("INSERT OR REPLACE INTO camera_remote_devices(rowid,id,owner_hash,sequence,name,phase,recording_id,project_id,updated_at,runtime_id,updated_tick) VALUES(?,?,?,?,'Handy','idle',NULL,NULL,?,?,?)");
 assert.throws(()=>replace.run(rowid,randomUUID(),'b'.repeat(64),1,1100,runtime,1100),/already exists/);
 assert.throws(()=>replace.run(null,deviceId,'b'.repeat(64),1,1100,runtime,1100),/already exists/);
 assert.throws(()=>db.prepare('UPDATE camera_remote_devices SET owner_hash=?,sequence=sequence+1 WHERE id=?').run('b'.repeat(64),deviceId),/invalid camera device change/);
 assert.throws(()=>db.prepare('DELETE FROM camera_remote_devices WHERE id=?').run(deviceId),/cannot be deleted/);
 assert.equal(listCameraDevices(db,1100)[0].lastSeen,1000);db.close();
});
test('deadline uses elapsed monotonic time even if wall clock jumps backward within the command window',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),clock(1000,1000));
 const command=start();queueCameraRequest(db,deviceId,command,clock(1100,1100));
 const poll=receiveCameraHeartbeat(db,heartbeat(),clock(2000,10100));
 assert.equal(poll[0].remainingMs,990); // wall suggests 9.09 s; monotonic clock reports 0.99 s
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),clock(1002,11101)).length,0);
 assert.equal(queueCameraRequest(db,deviceId,command,clock(1101,11102)).result,'server_expired');
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),clock(1102,12000)).length,0);db.close();
});
test('a queued command and stale device expire safely when the server process changes',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),clock(1000,1000));
 const command=start();queueCameraRequest(db,deviceId,command,clock(1100,1100));const restarted=clock(1200,10,randomUUID());
 assert.equal(listCameraDevices(db,restarted).length,0);
 assert.equal(queueCameraRequest(db,deviceId,command,restarted).result,'server_expired');
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),restarted),/nicht erreichbar/);
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),restarted).length,0);db.close();
});
test('a suspend-like wall advance expires a command even if monotonic time pauses',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),clock(1000,1000));
 const command=start();queueCameraRequest(db,deviceId,command,clock(1100,1100));
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),clock(21100,1200)).length,0);
 assert.equal(queueCameraRequest(db,deviceId,command,clock(21101,1201)).result,'server_expired');
 assert.equal(receiveCameraHeartbeat(db,heartbeat(),clock(1200,1300)).length,0);db.close();
});
test('device identity, sequence and command idempotence survive database reopen',()=>{
 const folder=mkdtempSync(join(tmpdir(),'camera-remote-test-'));let db;
 try{
  const path=join(folder,'db.sqlite');db=new Database(path);db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);
  const report=heartbeat(),command=start();receiveCameraHeartbeat(db,report,1000);queueCameraRequest(db,deviceId,command,1100);db.close();
  db=new Database(path);ensureCameraRemoteSchema(db);
  assert.throws(()=>receiveCameraHeartbeat(db,{...report,sequence:report.sequence+1},1200,'b'.repeat(64)),/Kamerasitzung/);
  assert.throws(()=>receiveCameraHeartbeat(db,report,1200),/Veraltete/);
  assert.equal(queueCameraRequest(db,deviceId,command,1200).created,false);
  assert.equal(receiveCameraHeartbeat(db,heartbeat(),1200)[0].id,command.id);
 } finally{db?.close();rmSync(folder,{recursive:true,force:true});}
});
test('stored command identity and decided results cannot be replaced, deleted or rolled back',()=>{
 const db=setup();db.pragma('recursive_triggers=OFF');db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);
 const rowid=db.prepare('SELECT rowid FROM camera_remote_commands WHERE id=?').get(command.id).rowid;
 const replace=db.prepare("INSERT OR REPLACE INTO camera_remote_commands(rowid,id,device_id,type,recording_id,project_id,created_at,expires_at,runtime_id,created_tick,expires_tick) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
 assert.throws(()=>replace.run(rowid,randomUUID(),deviceId,'record_start',randomUUID(),projectId,1200,11190,runtime,1200,11190),/already exists/);
 assert.throws(()=>replace.run(null,command.id,deviceId,'record_start',randomUUID(),projectId,1200,11190,runtime,1200,11190),/already exists/);
 assert.throws(()=>replace.run(null,randomUUID(),deviceId,'record_start',takeId,projectId,1200,11190,runtime,1200,11190),/already exists/);
 assert.throws(()=>db.prepare('UPDATE camera_remote_commands SET recording_id=? WHERE id=?').run(randomUUID(),command.id),/invalid camera command change/);
 receiveCameraHeartbeat(db,heartbeat(),1250);
 receiveCameraHeartbeat(db,heartbeat({ack:[{id:command.id,result:'accepted'}]}),1300);
 assert.throws(()=>db.prepare("UPDATE camera_remote_commands SET result='queued' WHERE id=?").run(command.id),/invalid camera command change/);
 assert.throws(()=>db.prepare('DELETE FROM camera_remote_commands WHERE id=?').run(command.id),/cannot be deleted/);
 assert.equal(db.prepare('SELECT recording_id FROM camera_remote_commands WHERE id=?').get(command.id).recording_id,takeId);db.close();
});
test('only a terminal error tied to the accepted take releases an uncertain start',()=>{
 const db=setup();db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100);
 receiveCameraHeartbeat(db,heartbeat(),1150);
 receiveCameraHeartbeat(db,heartbeat({phase:'error',ack:[{id:command.id,result:'accepted'}]}),1200);
 receiveCameraHeartbeat(db,heartbeat(),1300);
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1301),/früherer Start/);
 receiveCameraHeartbeat(db,heartbeat({phase:'error',recordingId:takeId,projectId}),1400);
 receiveCameraHeartbeat(db,heartbeat(),1500);
 assert.equal(queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1501).created,true);db.close();
});
test('serial fake client captures state and sequence together and never overlaps polls',async()=>{
 const db=setup();let state={phase:'idle',recordingId:null,projectId:null},sequenceNumber=0,inFlight=0,maximum=0;
 let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});let tail=Promise.resolve();
 const poll=()=>{const next=tail.then(async()=>{const snapshot={...state,sequence:++sequenceNumber};inFlight++;maximum=Math.max(maximum,inFlight);if(sequenceNumber===1){entered();await blocked;}receiveCameraHeartbeat(db,heartbeat(snapshot),1000+sequenceNumber);inFlight--;});tail=next;return next;};
 const first=poll();await started;state={phase:'recording',recordingId:takeId,projectId};const second=poll();
 assert.equal(inFlight,1);release();await Promise.all([first,second]);assert.equal(maximum,1);
 assert.equal(listCameraDevices(db,1003)[0].phase,'recording');db.close();
});
test('session quotas and bounded list fail closed without deleting identities',()=>{
 const db=setup(),limits={...CAMERA_LIMITS,devicesPerOwner:2,devicesTotal:3,visible:1};
 receiveCameraHeartbeat(db,heartbeat(),1000,'a'.repeat(64),limits);
 receiveCameraHeartbeat(db,heartbeat({id:otherDevice}),1001,'a'.repeat(64),limits);
 assert.throws(()=>receiveCameraHeartbeat(db,heartbeat({id:randomUUID()}),1002,'a'.repeat(64),limits),/grenze/);
 const third=randomUUID();receiveCameraHeartbeat(db,heartbeat({id:third}),1003,'b'.repeat(64),limits);
 assert.throws(()=>receiveCameraHeartbeat(db,heartbeat({id:randomUUID()}),1004,'c'.repeat(64),limits),/grenze/);
 const visible=list(db,clock(1005),limits);assert.equal(visible.devices.length,1);assert.equal(visible.hasMore,true);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_devices').get().n,3);db.close();
});
test('command quotas refuse new IDs while preserving exact retries and earlier decisions',()=>{
 const db=setup(),limits={...CAMERA_LIMITS,commandsPerDevice:2,commandsTotal:4};db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);
 for(const id of [deviceId,otherDevice])receiveCameraHeartbeat(db,heartbeat({id}),1000,'a'.repeat(64),limits);
 const first=start();queueCameraRequest(db,deviceId,first,1100,limits);
 receiveCameraHeartbeat(db,heartbeat(),1150);
 receiveCameraHeartbeat(db,heartbeat({ack:[{id:first.id,result:'rejected'}]}),1200);
 assert.equal(queueCameraRequest(db,deviceId,first,1201,limits).created,false);
 assert.throws(()=>queueCameraRequest(db,deviceId,start({recordingId:randomUUID()}),1202,limits),/grenze/);
 queueCameraRequest(db,otherDevice,start({recordingId:randomUUID()}),1203,limits);
 const third=randomUUID();receiveCameraHeartbeat(db,heartbeat({id:third}),1204);
 assert.throws(()=>queueCameraRequest(db,third,start({recordingId:randomUUID()}),1205,limits),/grenze/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_commands').get().n,2);db.close();
});
test('a start reserves the last device and global slot for its first matching stop',()=>{
 const db=setup(),limits={...CAMERA_LIMITS,commandsPerDevice:2,commandsTotal:3};db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);
 for(const id of [deviceId,otherDevice])receiveCameraHeartbeat(db,heartbeat({id}),1000,'a'.repeat(64),limits);
 const first=start();queueCameraRequest(db,deviceId,first,1100,limits);
 assert.throws(()=>queueCameraRequest(db,otherDevice,start({recordingId:randomUUID()}),1101,limits),/grenze/);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:first.id,result:'accepted'}]}),1200);
 const stop=start({type:'record_stop',projectId:null});assert.equal(queueCameraRequest(db,deviceId,stop,1300,limits).created,true);
 assert.equal(queueCameraRequest(db,deviceId,stop,1301,limits).created,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_commands').get().n,1);db.close();
});
test('a reserved first stop survives a later reduction of configured quotas',()=>{
 const db=setup(),original={...CAMERA_LIMITS,commandsPerDevice:2,commandsTotal:2},reduced={...original,commandsPerDevice:1,commandsTotal:1};
 db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100,original);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:command.id,result:'accepted'}]}),1200);
 assert.equal(queueCameraRequest(db,deviceId,start({type:'record_stop',projectId:null}),1300,reduced).created,true);db.close();
});
test('racing starts cannot consume another take’s reserved stop slot',async()=>{
 const db=setup(),limits={...CAMERA_LIMITS,commandsPerDevice:2,commandsTotal:3};db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);
 for(const id of [deviceId,otherDevice])receiveCameraHeartbeat(db,heartbeat({id}),1000,'a'.repeat(64),limits);
 const first=start(),second=start({recordingId:randomUUID()});
 const outcomes=await Promise.allSettled([Promise.resolve().then(()=>queueCameraRequest(db,deviceId,first,1100,limits)),Promise.resolve().then(()=>queueCameraRequest(db,otherDevice,second,1100,limits))]);
 assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
 const winner=outcomes[0].status==='fulfilled'?{id:deviceId,take:first.recordingId,cmd:first}:{id:otherDevice,take:second.recordingId,cmd:second};
 receiveCameraHeartbeat(db,heartbeat({id:winner.id,phase:'recording',recordingId:winner.take,projectId,ack:[{id:winner.cmd.id,result:'accepted'}]}),1200);
 assert.equal(queueCameraRequest(db,winner.id,start({type:'record_stop',recordingId:winner.take,projectId:null}),1300,limits).created,true);db.close();
});
test('an expired or rejected stop delivery retries the same intent without consuming command quota',()=>{
 const db=setup(),limits={...CAMERA_LIMITS,commandsPerDevice:2,commandsTotal:2};db.prepare('INSERT INTO projects(id) VALUES(?)').run(projectId);receiveCameraHeartbeat(db,heartbeat(),1000);
 const command=start();queueCameraRequest(db,deviceId,command,1100,limits);
 receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:command.id,result:'accepted'}]}),1200);
 const stop=start({type:'record_stop',projectId:null});const queued=queueCameraRequest(db,deviceId,stop,1300,limits);
 const retry=receiveCameraHeartbeat(db,heartbeat({phase:'recording',recordingId:takeId,projectId,ack:[{id:queued.id,result:'expired'}]}),1400);
 assert.equal(retry[0].id,queued.id);
 assert.equal(queueCameraRequest(db,deviceId,start({type:'record_stop',projectId:null}),1401,limits).id,queued.id);
 assert.equal(listCameraDevices(db,1402)[0].phase,'recording');db.close();
});
