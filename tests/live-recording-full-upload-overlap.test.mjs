import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,cameraUploadIdFor,lockAndValidateCameraUpload,releaseCameraUploadLock} from '../lib/camera-project-claims.ts';
import {acquireRecordingUpload} from '../lib/recording-upload-guard.ts';
import {createLiveStaging,initializeLiveStaging} from '../lib/live-recording-staging.ts';

// Everything here is synthetic and private; no route or production flag is enabled.
for (const order of ['live-first', 'whole-file-first']) for(const differentProject of [false,true]) test(`${order} blocks deterministic legacy full upload for the same take${differentProject?' across projects':''}`, () => {
 const root=mkdtempSync(path.join(tmpdir(),'videomaker-live-overlap-'));
 const filename=path.join(root,'synthetic.sqlite'),db=new Database(filename); let store, lease;
 const project=randomUUID(),otherProject=differentProject?randomUUID():project,recording=randomUUID(),id=cameraUploadIdFor(recording,project),fullId=cameraUploadIdFor(recording,otherProject);
 try {
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');db.prepare('INSERT INTO projects VALUES(?)').run(project);
  if(differentProject)db.prepare('INSERT INTO projects VALUES(?)').run(otherProject);
  db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);initializeLiveStaging(db);
  store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n);
  lease=acquireRecordingUpload(db);assert.ok(lease);
  const startLive=()=>store.begin(id,project,recording);
  const lockWhole=()=>lockAndValidateCameraUpload(db,lease.token,fullId,null,otherProject,1,'a'.repeat(64),lease.check);
  if(order==='live-first'){
   startLive();assert.throws(lockWhole,/Liveaufnahme/);
   assert.ok(db.prepare('SELECT 1 FROM live_recording_stages WHERE id=? AND recording_id=?').get(id,recording));
   assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_upload_locks').get().n,0);
  }else{
   lockWhole();assert.throws(startLive,/FULL_UPLOAD_IN_PROGRESS/);
   assert.equal(db.prepare('SELECT count(*) AS n FROM live_recording_stages').get().n,0);
   assert.ok(db.prepare('SELECT 1 FROM camera_project_upload_locks WHERE upload_id=? AND token=?').get(fullId,lease.token));
  }
 } finally {
  if(lease){releaseCameraUploadLock(db,lease.token);lease.release();}
  if(store && db.prepare('SELECT 1 FROM live_recording_stages WHERE id=?').get(id))store.cancel(id,project,recording);
  db.close();unlinkSync(filename);
  rmdirSync(path.join(root,'.live-recording-staging'));rmdirSync(root);
 }
});

test('legacy arbitrary upload is allowed normally and temporarily postponed during a live take',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'videomaker-live-legacy-'));
 const filename=path.join(root,'synthetic.sqlite'),db=new Database(filename);let store,lease;
 const project=randomUUID(),recording=randomUUID(),liveId=cameraUploadIdFor(recording,project),legacyId=randomUUID();
 try{
  db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);initializeLiveStaging(db);
  store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n);lease=acquireRecordingUpload(db);assert.ok(lease);
  assert.doesNotThrow(()=>lockAndValidateCameraUpload(db,lease.token,legacyId,null,project,1,'a'.repeat(64),lease.check));
  releaseCameraUploadLock(db,lease.token);
  store.begin(liveId,project,recording);
  assert.throws(()=>lockAndValidateCameraUpload(db,lease.token,legacyId,null,project,1,'a'.repeat(64),lease.check),/später erneut versuchen/);
  store.cancel(liveId,project,recording);
  assert.doesNotThrow(()=>lockAndValidateCameraUpload(db,lease.token,legacyId,null,project,1,'a'.repeat(64),lease.check));
 }finally{
  if(lease){releaseCameraUploadLock(db,lease.token);lease.release();}
  if(store&&db.prepare('SELECT 1 FROM live_recording_stages WHERE id=?').get(liveId))store.cancel(liveId,project,recording);
  db.close();unlinkSync(filename);rmdirSync(path.join(root,'.live-recording-staging'));rmdirSync(root);
 }
});

test('concurrent processes cannot simultaneously reserve live and whole-file paths',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'videomaker-live-path-race-'));
 const filename=path.join(root,'synthetic.sqlite'),db=new Database(filename);
 const project=randomUUID(),recording=randomUUID(),id=cameraUploadIdFor(recording,project);
 db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);initializeLiveStaging(db);
 const workers=['live','full'].map(mode=>fork(new URL('./fixtures/live-full-integration-worker.mjs',import.meta.url),[filename,root,id,project,recording,mode],{stdio:['ignore','ignore','pipe','ipc'],execArgv:['--experimental-strip-types']}));
 const exits=workers.map(worker=>new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal}))));
 try{
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);} )));
  const replies=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
  for(const worker of workers)worker.send('go');
  assert.deepEqual((await Promise.all(replies)).map(x=>x.result).sort(),['acquired','blocked']);
 }finally{
  for(const worker of workers)if(worker.connected)worker.send('stop');
  const finished=await Promise.all(exits);assert.ok(finished.every(x=>x.code===0),JSON.stringify(finished));
  db.close();unlinkSync(filename);rmdirSync(path.join(root,'.live-recording-staging'));rmdirSync(root);
 }
});
