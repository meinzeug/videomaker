import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,claimCameraProject,cameraUploadIdFor,lockAndValidateCameraUpload,releaseCameraUploadLock,recordCameraDeviceManifest,ensureCameraClaimUploadMappings} from '../lib/camera-project-claims.ts';
import {acquireRecordingUpload} from '../lib/recording-upload-guard.ts';
const good='a'.repeat(64),bad='b'.repeat(64),noCheck=()=>{};
function fixture(){const db=new Database(':memory:'),project=randomUUID(),take=randomUUID(),device=randomUUID();db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE project_recordings(id TEXT PRIMARY KEY); CREATE TABLE recording_upload_slots(token TEXT); CREATE TABLE recording_upload_owners(token TEXT PRIMARY KEY,completed INTEGER NOT NULL,host TEXT NOT NULL DEFAULT '',boot TEXT NOT NULL DEFAULT '',pid INTEGER NOT NULL DEFAULT 0,pidns TEXT NOT NULL DEFAULT '',process_start TEXT NOT NULL DEFAULT '')");db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);db.prepare('INSERT INTO projects VALUES(?)').run(project);return {db,project,take,device,uploadId:cameraUploadIdFor(take,project)};}
const claim=f=>f.db.transaction(()=>claimCameraProject(f.db,f.take,f.device,f.project,100)).immediate();
const lock=(f,token,recording=f.take,size=42,sha=good)=>lockAndValidateCameraUpload(f.db,token,f.uploadId,recording,f.project,size,sha,noCheck);
function expectCode(fn,code){assert.throws(fn,error=>error.gateCode===code);}
test('camera upload requires reserved identity and verified READY proof before accepting a slot',()=>{
 const f=fixture();claim(f);
 expectCode(()=>lock(f,randomUUID(),null),'camera_manifest_required');
 expectCode(()=>lock(f,randomUUID()),'camera_manifest_pending');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_upload_locks').get().n,0);
 f.db.transaction(()=>recordCameraDeviceManifest(f.db,f.device,f.take,f.project,'ready',42,good,110)).immediate();
 expectCode(()=>lock(f,randomUUID(),f.take,43,good),'camera_manifest_mismatch');
 expectCode(()=>lock(f,randomUUID(),f.take,42,bad),'camera_manifest_mismatch');
 const token=randomUUID();lock(f,token);assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_upload_locks').get().n,1);
 expectCode(()=>lock(f,randomUUID()),'camera_upload_busy');releaseCameraUploadLock(f.db,token);f.db.close();
});
test('partial is rejected and missing or mismatched reservation cannot bind an upload',()=>{
 const f=fixture();expectCode(()=>lock(f,randomUUID()),'camera_manifest_mismatch');claim(f);
 f.db.transaction(()=>recordCameraDeviceManifest(f.db,f.device,f.take,f.project,'partial',42,good,110)).immediate();
 expectCode(()=>lock(f,randomUUID()),'camera_manifest_partial');
 assert.throws(()=>f.db.prepare('DELETE FROM camera_project_upload_ids').run(),/cannot be deleted/);f.db.close();
});
test('in-flight ordinary upload blocks competing camera START before any side effect',()=>{
 const f=fixture(),token=randomUUID();lock(f,token,null);assert.throws(()=>claim(f),/bereits hochgeladen/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_claims').get().n,0);
 releaseCameraUploadLock(f.db,token);assert.equal(claim(f),true);f.db.close();
});
test('missing or expired owner cannot release a potentially active upload lock',()=>{
 const f=fixture(),token=randomUUID();lock(f,token,null);f.db.prepare('INSERT INTO recording_upload_owners(token,completed) VALUES(?,0)').run(token);
 expectCode(()=>lock(f,randomUUID(),null),'camera_upload_busy');
 f.db.prepare('UPDATE recording_upload_owners SET completed=1 WHERE token=?').run(token);
 lock(f,randomUUID(),null);f.db.close();
});
test('existing recordings and orphan intent files cannot be reserved by a camera START',()=>{
 const f=fixture();f.db.prepare('INSERT INTO project_recordings VALUES(?)').run(f.uploadId);assert.throws(()=>claim(f),/bereits verwendet/);f.db.prepare('DELETE FROM project_recordings').run();
 const folder=mkdtempSync(join(tmpdir(),'camera-gate-')),previous=process.env.DATA_DIR;
 try{process.env.DATA_DIR=folder;mkdirSync(join(folder,'recordings'));writeFileSync(join(folder,'recordings',`.upload-intent-${f.uploadId}.json`),'fixture');assert.throws(()=>claim(f),/Datei belegt/);}
 finally{if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(folder,{recursive:true,force:true});f.db.close();}
});
test('mapping migration reserves pre-existing claims before uploads',()=>{
 const f=fixture();f.db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,100)').run(f.take,f.device,f.project);
 ensureCameraClaimUploadMappings(f.db);ensureCameraClaimUploadMappings(f.db);
 assert.equal(f.db.prepare('SELECT upload_id FROM camera_project_upload_ids WHERE recording_id=?').get(f.take).upload_id,f.uploadId);
 expectCode(()=>lock(f,randomUUID(),null),'camera_manifest_required');f.db.close();
});
test('expired lease is not enough; a provably dead upload owner can be retried idempotently',()=>{
 const db=new Database(':memory:'),uploadId=randomUUID(),project=randomUUID();
 try{
  db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);let now=1000;const first=acquireRecordingUpload(db,()=>now);
  lockAndValidateCameraUpload(db,first.token,uploadId,null,project,0,null,first.check);
  now+=46000;const second=acquireRecordingUpload(db,()=>now);assert.ok(second);
  assert.throws(()=>lockAndValidateCameraUpload(db,second.token,uploadId,null,project,0,null,second.check),e=>e.gateCode==='camera_upload_busy');
  const child=spawnSync(process.execPath,['-e','']);assert.equal(child.status,0);
  db.prepare('UPDATE recording_upload_owners SET pid=? WHERE token=?').run(child.pid,first.token);
  lockAndValidateCameraUpload(db,second.token,uploadId,null,project,0,null,second.check);
  assert.equal(db.prepare('SELECT token FROM camera_project_upload_locks WHERE upload_id=?').get(uploadId).token,second.token);
  releaseCameraUploadLock(db,second.token);second.release();
 }finally{db.close();}
});
