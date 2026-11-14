import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,CameraUploadGateError,cameraUploadIdFor,closeCameraClaimAfterUpload,lockAndValidateCameraUpload,recordCameraVerifiedUpload} from '../lib/camera-project-claims.ts';

function fixture(){
 const db=new Database(':memory:');db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
 const recording=randomUUID(),project=randomUUID(),device=randomUUID(),upload=cameraUploadIdFor(recording,project),hash='a'.repeat(64),size=42,token=randomUUID();
 db.prepare('INSERT INTO camera_project_claims VALUES(?,?,?,?,NULL)').run(recording,device,project,1);
 db.prepare('INSERT INTO camera_project_upload_ids VALUES(?,?,?)').run(upload,recording,project);
 db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(recording,project,device,2);
 db.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(recording,project,device,size,hash,2);
 const fail=()=>db.prepare("INSERT INTO camera_project_failures VALUES(?,?,?,'error',?)").run(recording,project,device,3);
 const gate=()=>lockAndValidateCameraUpload(db,token,upload,recording,project,size,hash,()=>{});
 const commit=()=>db.transaction(()=>recordCameraVerifiedUpload(db,recording,project,upload,hash,size,4)).immediate();
 const isOpen=()=>db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(recording).closed_at===null;
 return {db,recording,project,device,upload,hash,size,fail,gate,commit,isOpen};
}

test('a conflicting device failure rejects the upload before its lock is created',()=>{
 const x=fixture();try{x.fail();assert.throws(x.gate,CameraUploadGateError);assert.equal(x.isOpen(),true);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM camera_project_upload_locks').get().n,0);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts').get().n,0);
 }finally{x.db.close();}
});

test('a failure arriving after the upload starts rejects and rolls back its receipt',()=>{
 const x=fixture();try{x.gate();x.fail();
  assert.throws(()=>x.db.transaction(()=>{
   x.db.prepare('CREATE TABLE scratch_transaction(value TEXT)').run();
   recordCameraVerifiedUpload(x.db,x.recording,x.project,x.upload,x.hash,x.size,4);
  }).immediate(),CameraUploadGateError);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='scratch_transaction'").get().n,0);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts').get().n,0);
  assert.equal(x.isOpen(),true);
 }finally{x.db.close();}
});

test('a later device status cannot close a claim when its stored evidence conflicts',()=>{
 const x=fixture();try{
  x.db.prepare('INSERT INTO camera_project_upload_receipts VALUES(?,?,?,?,?,?)').run(x.recording,x.project,x.upload,x.hash,x.size,2);
  x.fail();x.db.transaction(()=>closeCameraClaimAfterUpload(x.db,x.device,x.recording,x.project,4)).immediate();
  assert.equal(x.isOpen(),true);
 }finally{x.db.close();}
});

test('a matching ready upload remains idempotent when no contradiction exists',()=>{
 const x=fixture();try{x.gate();x.commit();assert.equal(x.isOpen(),false);x.commit();
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts').get().n,1);
 }finally{x.db.close();}
});
