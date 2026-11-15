import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,cameraUploadIdFor,lockAndValidateCameraUpload,releaseCameraUploadLock} from '../lib/camera-project-claims.ts';
import {acquireRecordingUpload} from '../lib/recording-upload-guard.ts';
import {createLiveStaging,initializeLiveStaging} from '../lib/live-recording-staging.ts';

// Characterization of an OPEN SAFETY GAP, not a passing exclusivity test.
// Everything here is synthetic and private; no route or production flag is enabled.
for (const order of ['live-first', 'whole-file-first']) test(`WIP: ${order} permits both upload owners for the same take`, () => {
 const root=mkdtempSync(path.join(tmpdir(),'videomaker-live-overlap-'));
 const db=new Database(':memory:'); let store, lease;
 const project=randomUUID(),recording=randomUUID(),id=cameraUploadIdFor(recording,project);
 try {
  db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);initializeLiveStaging(db);
  store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n);
  lease=acquireRecordingUpload(db);assert.ok(lease);
  const startLive=()=>store.begin(id,project,recording);
  const lockWhole=()=>lockAndValidateCameraUpload(db,lease.token,id,null,project,1,'a'.repeat(64),lease.check);
  if(order==='live-first'){startLive();lockWhole();}else{lockWhole();startLive();}
  assert.ok(db.prepare('SELECT 1 FROM live_recording_stages WHERE id=? AND recording_id=?').get(id,recording));
  assert.ok(db.prepare('SELECT 1 FROM camera_project_upload_locks WHERE upload_id=? AND token=?').get(id,lease.token));
  // Both logical owners exist concurrently. This deliberately records the
  // failure to fence, and does not upload or publish any recording.
 } finally {
  if(lease){releaseCameraUploadLock(db,lease.token);lease.release();}
  if(store && db.prepare('SELECT 1 FROM live_recording_stages WHERE id=?').get(id))store.cancel(id,project,recording);
  db.close();
  rmdirSync(path.join(root,'.live-recording-staging'));rmdirSync(root);
 }
});
