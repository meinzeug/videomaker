// Only run against a separate local dev server and explicitly marked test directory.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';
import {uploadCameraRecovery} from '../lib/camera-recovery-client.ts';

const base=process.env.CAMERA_RECOVERY_TEST_SERVER,dir=process.env.CAMERA_RECOVERY_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3334'&&process.env.CAMERA_RECOVERY_TEST_ALLOW_WRITES==='1'&&typeof dir==='string';

test('verified copy from another device closes only its matching READY claim',{skip:!enabled,timeout:90000},async()=>{
 const resolved=realpathSync(dir);assert.equal(path.dirname(resolved),'/tmp');assert.match(path.basename(resolved),/^camera-recovery-e2e-[A-Za-z0-9]+$/);
 assert.equal(readFileSync(path.join(resolved,'disposable-fixture'),'utf8'),'camera-recovery-fixture\n');
 const post=(url,cookie,body)=>fetch(base+url,{method:'POST',headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
 const login=await post('/api/login','',{password:'camera-recovery-test'});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const created=await post('/api/projects',cookie,{title:'Synthetisches Testskript',script:'Testtext',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(created.status,201);
 const project=(await created.json()).id;
 assert.equal((await fetch(base+'/api/camera-devices',{headers:{cookie}})).status,200);
 const recording=randomUUID(),device=randomUUID(),uploadId=cameraUploadIdFor(recording,project);
 const bytes=Buffer.from('synthetic test bytes, not an actual video'),proof={sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const db=new Database(path.join(resolved,'videomaker.sqlite'),{fileMustExist:true});
 try{
  db.transaction(()=>{
   db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,?)').run(recording,device,project,100);
   db.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)').run(uploadId,recording,project);
   db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(recording,project,device,110);
   db.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(recording,project,device,proof.sizeBytes,proof.sha256,110);
  }).immediate();
  const get=async()=>{const r=await fetch(base+`/api/camera-devices/claims?projectId=${project}`,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
  const before=await get();assert.equal(before.claims.length,1);assert.equal(before.claims[0].deviceName,null);assert.deepEqual(before.claims[0].recovery,proof);
  const request=(url,options)=>fetch(base+url,{...options,headers:{...options.headers,cookie,origin:base}});
  const file=new Blob([bytes],{type:'video/mp4'}),signal=new AbortController().signal;
  const receipt=await uploadCameraRecovery(file,project,recording,proof,signal,request);
  assert.equal(receipt.uploadId,uploadId);
  assert.notEqual(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(recording).closed_at,null);
  assert.equal((await get()).claims.length,0);
  const downloaded=await fetch(base+`/api/projects/${project}/recordings/${uploadId}?download=1`,{headers:{cookie}});assert.equal(downloaded.status,200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
  assert.deepEqual(await uploadCameraRecovery(file,project,recording,proof,signal,request),receipt);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_recordings WHERE project_id=?').get(project).n,1);
  // Simulate losing the response only after the server has committed it.
  const retryRecording=randomUUID(),retryDevice=randomUUID(),retryUpload=cameraUploadIdFor(retryRecording,project);
  db.transaction(()=>{
   db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,?)').run(retryRecording,retryDevice,project,200);
   db.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)').run(retryUpload,retryRecording,project);
   db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(retryRecording,project,retryDevice,210);
   db.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(retryRecording,project,retryDevice,proof.sizeBytes,proof.sha256,210);
  }).immediate();
  const loseResponse=async(url,options)=>{const response=await request(url,options);assert.equal(response.status,201);await response.arrayBuffer();throw Error('synthetic response loss');};
  await assert.rejects(uploadCameraRecovery(file,project,retryRecording,proof,signal,loseResponse),/synthetic response loss/);
  assert.notEqual(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(retryRecording).closed_at,null);
  const recovered=await uploadCameraRecovery(file,project,retryRecording,proof,signal,request);
  assert.equal(recovered.uploadId,retryUpload);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_recordings WHERE id=?').get(retryUpload).n,1);
  // Hold the stream after the server's manifest gate, then deliver a
  // contradictory device error before the final commit transaction.
  const raceRecording=randomUUID(),raceDevice=randomUUID(),raceUpload=cameraUploadIdFor(raceRecording,project);
  db.transaction(()=>{
   db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,?)').run(raceRecording,raceDevice,project,300);
   db.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)').run(raceUpload,raceRecording,project);
   db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(raceRecording,project,raceDevice,310);
   db.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(raceRecording,project,raceDevice,proof.sizeBytes,proof.sha256,310);
  }).immediate();
  let release;const pendingChunk=new Promise(resolve=>{release=resolve;});
  const stream=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,8));},async pull(controller){await pendingChunk;controller.enqueue(bytes.subarray(8));controller.close();}});
  const abort=new AbortController();
  const inFlight=fetch(base+`/api/projects/${project}/recordings`,{method:'POST',duplex:'half',signal:abort.signal,headers:{cookie,origin:base,'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':raceUpload,'x-camera-recording-id':raceRecording,'x-content-sha256':proof.sha256},body:stream});
  try{
   let locked=false;for(let i=0;i<250;i++){
    if(db.prepare('SELECT 1 FROM camera_project_upload_locks WHERE upload_id=?').get(raceUpload)){locked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(locked,true,'Upload passed the initial gate');
   db.prepare("INSERT INTO camera_project_failures VALUES(?,?,?,'error',?)").run(raceRecording,project,raceDevice,320);
   release();const response=await inFlight;assert.equal(response.status,409);assert.equal((await response.json()).code,'camera_manifest_mismatch');
   assert.equal(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(raceRecording).closed_at,null);
   assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_upload_receipts WHERE recording_id=?').get(raceRecording).n,0);
   assert.equal(db.prepare('SELECT count(*) AS n FROM project_recordings WHERE id=?').get(raceUpload).n,0);
  }finally{release();abort.abort();await inFlight.catch(()=>{});}
 }finally{db.close();}
});
