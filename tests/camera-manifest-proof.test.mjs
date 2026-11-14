import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,receiveCameraHeartbeat,queueCameraRequest} from '../lib/camera-remote-store.ts';
import {cameraUploadIdFor,recordCameraVerifiedUpload} from '../lib/camera-project-claims.ts';
const owner='a'.repeat(64),good='b'.repeat(64),bad='c'.repeat(64),runtimeId=randomUUID();
const clock=n=>({runtimeId,wall:n,tick:n});
function fixture(path=':memory:'){
 const db=new Database(path),device=randomUUID(),project=randomUUID(),take=randomUUID(),command=randomUUID();let sequence=0;
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?)').run(project);
 const report=(phase,extra={})=>parseCameraHeartbeat({id:device,sequence:++sequence,name:'Test',capability:'remote-record-v1',phase,recordingId:phase==='idle'?null:take,projectId:phase==='idle'?null:project,ack:[],...(['ready','partial'].includes(phase)?{sizeBytes:42,sha256:good}:{}),...extra});
 const poll=(phase,n,authenticated=true,extra={})=>receiveCameraHeartbeat(db,report(phase,extra),clock(n),owner,undefined,authenticated);
 poll('idle',1000);queueCameraRequest(db,device,{id:command,type:'record_start',recordingId:take,projectId:project},clock(1100));poll('idle',1150);
 return {db,device,project,take,command,poll,report};
}
function upload(f,hash=good,size=42){return f.db.transaction(()=>recordCameraVerifiedUpload(f.db,f.take,f.project,cameraUploadIdFor(f.take,f.project),hash,size,1500)).immediate();}
function closed(f){return f.db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(f.take).closed_at;}
test('READY/PARTIAL require exact positive integer size and lowercase SHA; other phases reject proof',()=>{
 const id=randomUUID();const base={id,sequence:1,name:'Test',capability:'remote-record-v1',phase:'ready',recordingId:randomUUID(),projectId:null,ack:[]};
 for(const patch of [{},{sizeBytes:0,sha256:good},{sizeBytes:1.2,sha256:good},{sizeBytes:Number.MAX_SAFE_INTEGER+1,sha256:good},{sizeBytes:1,sha256:good.toUpperCase()},{sizeBytes:1,sha256:'x'.repeat(64)},{sizeBytes:1,sha256:null}])assert.throws(()=>parseCameraHeartbeat({...base,...patch}));
 assert.equal(parseCameraHeartbeat({...base,sizeBytes:42,sha256:good}).sizeBytes,42);
 assert.throws(()=>parseCameraHeartbeat({...base,phase:'recording',sizeBytes:42,sha256:good}));
 assert.equal(parseCameraHeartbeat({...base,phase:'idle',recordingId:null,projectId:null,sizeBytes:null,sha256:null}).sha256,null);
});
test('a legacy or unauthenticated report cannot make a matching upload authoritative',()=>{
 const f=fixture();f.poll('ready',1200,false);upload(f);assert.equal(closed(f),null);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_device_manifests').get().n,0);f.db.close();
});
test('foreign bytes cannot close the claim and the device proof cannot be changed',()=>{
 const f=fixture();upload(f,bad,42);f.poll('ready',1600,true);assert.equal(closed(f),null);
 assert.throws(()=>f.poll('ready',1700,true,{sha256:bad}),/Gerätenachweis/);assert.equal(closed(f),null);
 assert.throws(()=>f.db.prepare('UPDATE camera_project_device_manifests SET sha256=?').run(bad),/cannot be changed/);
 assert.throws(()=>f.db.prepare('DELETE FROM camera_project_device_manifests').run(),/cannot be deleted/);f.db.close();
});
test('size mismatch never closes the claim even when hashes match',()=>{
 const f=fixture();f.poll('ready',1200,true);upload(f,good,43);assert.equal(closed(f),null);f.db.close();
});
test('matching proof and upload close in either order, including idle and database reopen',()=>{
 for(const proofFirst of [true,false]){
  const folder=mkdtempSync(join(tmpdir(),'camera-proof-'));let f;
  try{
   const path=join(folder,'fixture.sqlite');f=fixture(path);
   if(proofFirst){f.poll('ready',1200,true);f.poll('idle',1300);f.db.close();f.db=new Database(path);upload(f);}
   else {upload(f);f.db.close();f.db=new Database(path);receiveCameraHeartbeat(f.db,f.report('ready'),clock(1600),owner,undefined,true);}
   assert.notEqual(closed(f),null);
  }finally{f?.db.close();rmSync(folder,{recursive:true,force:true});}
 }
});
test('a matching partial manifest remains open and never masquerades as a complete cloud video',()=>{
 const f=fixture();f.poll('partial',1200,true);upload(f);assert.equal(closed(f),null);f.db.close();
});
test('the manifest must match the claimed device and project',()=>{
 const f=fixture();upload(f);assert.throws(()=>f.poll('ready',1600,true,{projectId:randomUUID()}),/passende offene/);assert.equal(closed(f),null);assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_device_manifests').get().n,0);f.db.close();
});
