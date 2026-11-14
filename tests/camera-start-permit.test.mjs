import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {CameraStartPermitIssuer} from '../lib/camera-start-permit.ts';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,queueCameraRequest,receiveCameraHeartbeat} from '../lib/camera-remote-store.ts';

const owner='a'.repeat(64),device=randomUUID(),project=randomUUID(),runtimeId=randomUUID();
const clock=(wall,tick=wall,runtime=runtimeId)=>({wall,tick,runtimeId:runtime});

test('server creates distinct IDs and binds the complete START request and owner',()=>{
 const issuer=new CameraStartPermitIssuer();
 const token=issuer.issue(owner,device.toUpperCase(),project.toUpperCase(),clock(1000));
 const grant=issuer.verify(token,owner,clock(1001));
 assert.equal(grant.deviceId,device);assert.equal(grant.request.projectId,project);
 assert.equal(grant.request.type,'record_start');
 assert.notEqual(grant.request.id,grant.request.recordingId);
 const second=issuer.verify(issuer.issue(owner,device,project,clock(1001)),owner,clock(1002));
 assert.notEqual(second.request.id,grant.request.id);
 assert.notEqual(second.request.recordingId,grant.request.recordingId);
 assert.throws(()=>issuer.verify(token,'b'.repeat(64),clock(1002)));
 assert.throws(()=>issuer.issue('z'.repeat(64),device,project,clock(1000)));
 assert.throws(()=>issuer.issue(owner,'invalid',project,clock(1000)));
});

test('modifying any authenticated binding, malformed encoding or signature fails closed',()=>{
 const issuer=new CameraStartPermitIssuer(),token=issuer.issue(owner,device,project,clock(1000));
 const [body,signature]=token.split('.'),payload=JSON.parse(Buffer.from(body,'base64url'));
 for(const index of [1,2,3,4,5,6,7,8,9,10]){
  const changed=[...payload];changed[index]=typeof changed[index]==='number'?changed[index]+1:randomUUID();
  assert.throws(()=>issuer.verify(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`,owner,clock(1001)));
 }
 for(const malformed of ['',token+'.extra',`${body}=.${signature}`,`${body}.${signature}=`,`${body}.${'A'.repeat(42)}A`,null,'x'.repeat(2049)])
  assert.throws(()=>issuer.verify(malformed,owner,clock(1001)));
});

test('expiry, rollback, restart, and another worker do not revive an old permit',()=>{
 const issuer=new CameraStartPermitIssuer(),token=issuer.issue(owner,device,project,clock(1000,500));
 assert.equal(issuer.verify(token,owner,clock(15999,15499)).deviceId,device);
 for(const time of [clock(16000,15499),clock(15999,15500),clock(999,500),clock(1000,499),clock(1001,501,randomUUID())])
  assert.throws(()=>issuer.verify(token,owner,time));
 assert.throws(()=>new CameraStartPermitIssuer().verify(token,owner,clock(1001,501)));
 for(const bad of [clock(NaN),clock(-1),clock(1000,-1),clock(1000,500,'bad')])
  assert.throws(()=>issuer.verify(token,owner,bad));
});

test('an observed clock rollback disables the generation even if the clock moves forward again',()=>{
 for(const changedClock of [clock(15999,15500),clock(16000,15499)]){
  const issuer=new CameraStartPermitIssuer(),token=issuer.issue(owner,device,project,clock(1000,500));
  assert.throws(()=>issuer.verify(token,owner,clock(16000,15500)));
  assert.throws(()=>issuer.verify(token,owner,changedClock));
  assert.throws(()=>issuer.issue(owner,device,project,clock(16001,15501)));
 }
});

test('lost queue response can retry the same permit within its lifetime without a second start',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);
 db.prepare('INSERT INTO projects(id) VALUES(?)').run(project);
 receiveCameraHeartbeat(db,parseCameraHeartbeat({id:device,sequence:1,name:'Kamera',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[]}),clock(1000),owner);
 const issuer=new CameraStartPermitIssuer(),token=issuer.issue(owner,device,project,clock(1000));
 const first=issuer.verify(token,owner,clock(1001));
 assert.equal(queueCameraRequest(db,first.deviceId,first.request,clock(1001)).created,true);
 const retry=issuer.verify(token,owner,clock(1002));
 assert.equal(queueCameraRequest(db,retry.deviceId,retry.request,clock(1002)).created,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_remote_commands').get().n,1);
 assert.throws(()=>issuer.verify(token,owner,clock(16000)));
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_claims WHERE closed_at IS NULL').get().n,1);
 db.close();
});
