import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,receiveCameraHeartbeat} from '../lib/camera-remote-store.ts';
import {cameraUploadIdFor,recordCameraVerifiedUpload} from '../lib/camera-project-claims.ts';
import {CAMERA_LATE_ALERT_LIMIT,CameraLateAlertError,listCameraLateAlerts,recordLateCameraAlert} from '../lib/camera-late-alerts.ts';

function fixture(location=':memory:',close=true){
 const db=new Database(location),project=randomUUID(),recording=randomUUID(),device=randomUUID(),runtimeId=randomUUID(),owner='a'.repeat(64),sha='b'.repeat(64),upload=cameraUploadIdFor(recording,project);
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL)');ensureCameraRemoteSchema(db);db.prepare('INSERT INTO projects VALUES(?,?)').run(project,'Testskript');
 const clock=n=>({runtimeId,wall:n,tick:n});
 const report=(sequence,phase='error',extra={})=>parseCameraHeartbeat({id:device,sequence,name:'Testkamera',capability:'remote-record-v1',phase,recordingId:phase==='idle'?null:recording,projectId:phase==='idle'?null:project,ack:[],...(phase==='partial'?{sizeBytes:42,sha256:sha}:{}),...extra});
 const poll=(input,n,authenticated=true)=>receiveCameraHeartbeat(db,input,clock(n),owner,undefined,authenticated);
 poll(report(1,'idle'),1);
 db.prepare('INSERT INTO camera_project_claims VALUES(?,?,?,?,NULL)').run(recording,device,project,2);
 db.prepare('INSERT INTO camera_project_upload_ids VALUES(?,?,?)').run(upload,recording,project);
 db.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(recording,project,device,42,sha,3);
 if(close)db.transaction(()=>recordCameraVerifiedUpload(db,recording,project,upload,sha,42,4)).immediate();
 return {db,project,recording,device,sha,clock,report,poll,upload};
}

test('authenticated late error is immutable, replay-safe and preserves upload evidence',()=>{
 const f=fixture();try{
  f.poll(f.report(2),10);const first=listCameraLateAlerts(f.db,null).alerts[0];
  assert.equal(first.phase,'error');assert.equal(first.sequence,2);assert.equal(first.projectTitle,'Testskript');
  f.poll(f.report(3),11);assert.deepEqual(listCameraLateAlerts(f.db,null).alerts,[first]);
  assert.throws(()=>f.poll(f.report(2),12),/Veraltete/);
  assert.throws(()=>f.db.prepare("UPDATE camera_late_alerts SET observed_at=5").run(),/cannot be changed/);
  assert.throws(()=>f.db.prepare('DELETE FROM camera_late_alerts').run(),/cannot be deleted/);
  assert.throws(()=>f.db.prepare("INSERT OR REPLACE INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at,size,sha256) SELECT recording_id,project_id,device_id,phase,sequence,observed_at,size,sha256 FROM camera_late_alerts").run(),/already exists/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts WHERE recording_id=?').get(f.recording).n,1);
  assert.notEqual(f.db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(f.recording).closed_at,null);
 }finally{f.db.close();}
});

test('a closed claim without matching verified receipt cannot create a late alert',()=>{
 for(const variant of ['missing','mismatched']){
  const f=fixture();try{
   if(variant==='missing')f.db.prepare('DELETE FROM camera_project_upload_receipts WHERE recording_id=?').run(f.recording);
   else f.db.prepare('UPDATE camera_project_upload_receipts SET sha256=? WHERE recording_id=?').run('c'.repeat(64),f.recording);
   assert.throws(()=>f.poll(f.report(2),10),/nicht eindeutig prüfbar/,variant);
   assert.equal(listCameraLateAlerts(f.db,null).alerts.length,0,variant);
   assert.equal(f.db.prepare('SELECT sequence FROM camera_remote_devices WHERE id=?').get(f.device).sequence,1);
  }finally{f.db.close();}
 }
});

test('late partial is retained separately without rewriting the original READY manifest',()=>{
 const f=fixture();try{
  f.poll(f.report(2,'partial',{sizeBytes:43,sha256:'c'.repeat(64)}),10);
  const alert=listCameraLateAlerts(f.db,null).alerts[0];assert.equal(alert.phase,'partial');assert.equal(alert.size,43);
  const manifest=f.db.prepare('SELECT phase,size,sha256 FROM camera_project_device_manifests WHERE recording_id=?').get(f.recording);
  assert.deepEqual(manifest,{phase:'ready',size:42,sha256:f.sha});
  const conflict=f.report(3,'partial',{sizeBytes:44,sha256:'d'.repeat(64)});
  assert.throws(()=>f.poll(conflict,11),error=>{
   assert.ok(error instanceof CameraLateAlertError);assert.equal(error.code,'conflict');
   assert.deepEqual(error.report,{deviceId:f.device,recordingId:f.recording,projectId:f.project,phase:'partial',sequence:3,sizeBytes:44,sha256:'d'.repeat(64)});
   return true;
  });
  assert.equal(f.db.prepare('SELECT sequence FROM camera_remote_devices WHERE id=?').get(f.device).sequence,2,'failed conflicting poll is rolled back');
 }finally{f.db.close();}
});

test('unverified, wrong-device and wrong-project reports never create an alert',()=>{
 for(const variant of ['unauthenticated','device','project']){
  const f=fixture();try{
   const extra=variant==='device'?{id:randomUUID()}:variant==='project'?{projectId:randomUUID()}:{};
   f.poll(f.report(2,'error',extra),10,variant!=='unauthenticated');
   assert.equal(listCameraLateAlerts(f.db,null).alerts.length,0,variant);
  }finally{f.db.close();}
 }
});

test('fixed capacity rejects new observations without overwriting old ones',()=>{
 const f=fixture();try{
  const input=f.report(2);f.db.transaction(()=>recordLateCameraAlert(f.db,input,true,10,1)).immediate();
  f.db.transaction(()=>recordLateCameraAlert(f.db,{...input,sequence:3},true,11,1)).immediate();
  assert.throws(()=>f.db.transaction(()=>recordLateCameraAlert(f.db,f.report(4,'partial'),true,12,1)).immediate(),e=>e instanceof CameraLateAlertError&&e.code==='capacity');
  assert.equal(listCameraLateAlerts(f.db,null).alerts.length,1);
 }finally{f.db.close();}
});

test('partial evidence cannot be stored without a valid hash',()=>{
 const f=fixture();try{
  const insert=f.db.prepare("INSERT INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at,size,sha256) VALUES(?,?,?,'partial',?,?,?,?)");
  assert.throws(()=>insert.run(f.recording,f.project,f.device,2,10,42,null),/CHECK/);
  assert.throws(()=>insert.run(f.recording,f.project,f.device,2,10,42,'x'.repeat(64)),/CHECK/);
  assert.equal(listCameraLateAlerts(f.db,null).alerts.length,0);
 }finally{f.db.close();}
});

test('alerts remain visible when their project is deleted',()=>{
 const f=fixture();try{f.poll(f.report(2),10);f.db.prepare('DELETE FROM projects WHERE id=?').run(f.project);
  const alert=listCameraLateAlerts(f.db,null).alerts[0];assert.equal(alert.projectTitle,null);assert.equal(alert.projectId,f.project);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts WHERE recording_id=?').get(f.recording).n,1);
 }finally{f.db.close();}
});

test('newest-first cursor pagination covers all entries without duplicates',()=>{
 const f=fixture();try{
  const insert=f.db.prepare("INSERT INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at) VALUES(?,?,?,'error',?,?)");
  f.db.transaction(()=>{for(let i=1;i<=205;i++)insert.run(randomUUID(),f.project,f.device,i,i);}).immediate();
  const first=listCameraLateAlerts(f.db,null);assert.equal(first.alerts.length,100);assert.equal(first.hasMore,true);
  const second=listCameraLateAlerts(f.db,first.nextBefore);assert.equal(second.alerts.length,100);assert.equal(second.hasMore,true);
  const third=listCameraLateAlerts(f.db,second.nextBefore);assert.equal(third.alerts.length,5);assert.equal(third.hasMore,false);
  const ids=[...first.alerts,...second.alerts,...third.alerts].map(alert=>alert.recordingId);
  assert.equal(new Set(ids).size,205);assert.equal(first.alerts[0].observedAt,205);assert.equal(third.alerts.at(-1).observedAt,1);
 }finally{f.db.close();}
});

test('full global capacity is visible to the dashboard',()=>{
 const f=fixture();try{
  const insert=f.db.prepare("INSERT INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at) VALUES(?,?,?,'error',?,?)");
  f.db.transaction(()=>{for(let i=1;i<=CAMERA_LATE_ALERT_LIMIT;i++)insert.run(randomUUID(),f.project,f.device,i,i);}).immediate();
  assert.equal(listCameraLateAlerts(f.db,null).capacityReached,true);
 }finally{f.db.close();}
});

test('pagination keys remain stable across SQLite VACUUM',()=>{
 const f=fixture();try{
  const insert=f.db.prepare("INSERT INTO camera_late_alerts(id,recording_id,project_id,device_id,phase,sequence,observed_at) VALUES(?,?,?,?,'error',?,?)");
  insert.run(10,randomUUID(),f.project,f.device,1,1);insert.run(20,randomUUID(),f.project,f.device,2,2);
  const before=listCameraLateAlerts(f.db,null).alerts.map(alert=>alert.cursor);f.db.exec('VACUUM');
  assert.deepEqual(listCameraLateAlerts(f.db,null).alerts.map(alert=>alert.cursor),before);
 }finally{f.db.close();}
});

test('persisted alert and poll sequence survive database reopen and reject a replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'camera-late-reopen-')),file=join(dir,'fixture.sqlite');let db;
 try{
  const f=fixture(file);f.poll(f.report(2),10);f.db.close();
  db=new Database(file);ensureCameraRemoteSchema(db);
  assert.equal(listCameraLateAlerts(db,null).alerts[0].recordingId,f.recording);
  assert.throws(()=>receiveCameraHeartbeat(db,f.report(2),f.clock(11),'a'.repeat(64),undefined,true),/Veraltete/);
  assert.equal(listCameraLateAlerts(db,null).alerts.length,1);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('a competing alert cannot overtake the receipt transaction; after commit it is recorded',()=>{
 const dir=mkdtempSync(join(tmpdir(),'camera-late-race-')),file=join(dir,'fixture.sqlite');let first,second;
 try{
  const f=fixture(file,false);first=f.db;second=new Database(file);second.pragma('busy_timeout=0');
  first.transaction(()=>{
   recordCameraVerifiedUpload(first,f.recording,f.project,f.upload,f.sha,42,4);
   assert.throws(()=>second.transaction(()=>recordLateCameraAlert(second,f.report(2),true,5)).immediate(),/locked/);
  }).immediate();
  f.poll(f.report(2),6);assert.equal(listCameraLateAlerts(first,null).alerts.length,1);
 }finally{second?.close();first?.close();rmSync(dir,{recursive:true,force:true});}
});
