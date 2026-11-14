import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,cameraUploadIdFor,claimCameraProject,recordCameraDeviceManifest} from '../lib/camera-project-claims.ts';
import {ensureCameraRemoteSchema} from '../lib/camera-remote-store.ts';

// The DB marker check below prevents accidental writes to a different studio.
const base=process.env.RECORDING_LOGOUT_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3389' && process.env.RECORDING_LOGOUT_TEST_ALLOW_WRITES==='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('logout fences new uploads, retry receipts, and orphan recovery without deleting bytes', {skip:!enabled,timeout:120000},async()=>{
 const fixture=realpathSync(process.env.RECORDING_LOGOUT_FIXTURE_DIR||'');
 assert.equal(dirname(fixture),realpathSync(tmpdir()));
 assert.match(basename(fixture),/^videomaker-recording-logout-fixture\.[A-Za-z0-9]{6,}$/);
 const marker=join(fixture,'.recording-logout-fixture');
 assert.equal(realpathSync(marker),marker);
 assert.equal(readFileSync(marker,'utf8'),'isolated-recording-logout\n');
 let cookie='';
 async function request(path,method='GET',body,headers={},explicitCookie=cookie){
  const h={Origin:base,...headers};if(explicitCookie)h.Cookie=explicitCookie;
  const r=await fetch(base+path,{method,headers:h,...(body===undefined?{}:{body})});
  return {status:r.status,headers:r.headers,body:await r.text()};
 }
 async function login(){
  const result=await request('/api/login','POST',JSON.stringify({password:'recording-logout-local-test'}),{'Content-Type':'application/json'},'');
  assert.equal(result.status,200);return result.headers.get('set-cookie').split(';',1)[0];
 }
 async function logout(value){assert.equal((await request('/api/logout','POST',undefined,{},value)).status,200);}
 cookie=await login();assert.equal((await request('/api/projects')).status,200);
 const file=join(fixture,'videomaker.sqlite');assert.equal(realpathSync(file),file);
 const db=new Database(file,{fileMustExist:true,timeout:5000});
 const projectId=randomUUID(),uniqueTitle='synthetic-upload-logout-'+randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(projectId,now,uniqueTitle,'[]',JSON.stringify({script:'Fixture only'}));
 const projects=JSON.parse((await request('/api/projects')).body);
 assert.ok(projects.some(p=>p.id===projectId&&p.title===uniqueTitle),'The HTTP server must use the marked disposable database.');
 const dir=join(fixture,'recordings'),url=`/api/projects/${projectId}/recordings`;
 const bytes=Buffer.from('synthetic fixture content: delayed upload with logout; no real video or user data');
 const sha=createHash('sha256').update(bytes).digest('hex');
 const common={'Content-Type':'video/mp4','Content-Length':String(bytes.length),'X-Content-SHA256':sha};
 async function streamPaused(recordingId,session,needsTemporary,extraHeaders={}){
  let finish;
  const result=new Promise((resolve,reject)=>{
   const q=http.request(base+url,{method:'POST',headers:{Origin:base,Cookie:session,...common,'X-Recording-Id':recordingId,...extraHeaders}},r=>{
    const chunks=[];r.on('data',x=>chunks.push(x));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks).toString()}));
   });
   q.on('error',reject);q.write(bytes.subarray(0,Math.floor(bytes.length/2)));
   finish=()=>q.end(bytes.subarray(Math.floor(bytes.length/2)));
  });
  for(let i=0;i<200;i++){
   const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recording_upload_slots'").get();
   const row=table?db.prepare('SELECT token FROM recording_upload_slots LIMIT 1').get():undefined;
   if(row&&(!needsTemporary||existsSync(join(dir,`.verified-upload-${row.token}`))))return {finish,result};
   await sleep(50);
  }
  throw new Error('The isolated upload did not begin.');
 }
 async function upload(id,session,extraHeaders={}){return request(url,'POST',bytes,{...common,'X-Recording-Id':id,...extraHeaders},session);}
 try{
  const id=randomUUID(),sessionA=cookie,sessionB=await login();
  const delayed=await streamPaused(id,sessionA,true);
  await logout(sessionA);delayed.finish();assert.equal((await delayed.result).status,403);
  assert.equal(db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(id),undefined);
  assert.equal(existsSync(join(dir,`${id}.mp4`)),false);
  assert.equal(existsSync(join(dir,`.upload-intent-${id}.json`)),false,'Logout must also fence the permanent identity marker.');
  let response=await upload(id,sessionB);assert.equal(response.status,201);assert.equal(JSON.parse(response.body).sha256,sha);
  const original=await readFile(join(dir,`${id}.mp4`));assert.deepEqual(original,bytes);

  const sessionC=await login(),delayedRetry=await streamPaused(id,sessionC,false);
  await logout(sessionC);delayedRetry.finish();assert.equal((await delayedRetry.result).status,403);
  assert.deepEqual(await readFile(join(dir,`${id}.mp4`)),original);
  response=await upload(id,sessionB);assert.equal(response.status,200);assert.equal(JSON.parse(response.body).sha256,sha);

  // A deferred foreign-key violation fails COMMIT after the final hard link
  // and INSERT. The orphan and intent must survive a denied old session.
  const orphanId=randomUUID();
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  db.exec(`CREATE TABLE recording_logout_parent(id INTEGER PRIMARY KEY);
   CREATE TABLE recording_logout_child(id INTEGER REFERENCES recording_logout_parent(id) DEFERRABLE INITIALLY DEFERRED);
   CREATE TRIGGER recording_logout_test_abort AFTER INSERT ON project_recordings WHEN NEW.id='${orphanId}' BEGIN INSERT INTO recording_logout_child VALUES(1); END`);
  // Verify the fixture violation occurs on commit, not on the insert itself.
  assert.throws(()=>db.transaction(()=>{db.prepare('INSERT INTO recording_logout_child VALUES(1)').run();assert.equal(db.prepare('SELECT count(*) AS n FROM recording_logout_child').get().n,1);}).immediate());
  try {assert.equal((await upload(orphanId,sessionB)).status,500);} finally {db.exec('DROP TRIGGER recording_logout_test_abort');}
  assert.deepEqual(await readFile(join(dir,`${orphanId}.mp4`)),bytes);
  const intentBefore=await readFile(join(dir,`.upload-intent-${orphanId}.json`));
  assert.equal(db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(orphanId),undefined);
  const sessionD=await login(),delayedOrphan=await streamPaused(orphanId,sessionD,true);
  await logout(sessionD);delayedOrphan.finish();assert.equal((await delayedOrphan.result).status,403);
  assert.deepEqual(await readFile(join(dir,`${orphanId}.mp4`)),bytes);
  assert.deepEqual(await readFile(join(dir,`.upload-intent-${orphanId}.json`)),intentBefore);
  assert.equal(db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(orphanId),undefined);
  response=await upload(orphanId,sessionB);assert.equal(response.status,201);assert.equal(JSON.parse(response.body).sha256,sha);
  assert.deepEqual(await readFile(join(dir,`${orphanId}.mp4`)),bytes);

  // Synthetic camera READY proof, upload reservation, and a file published by a
  // previous request before its receipt. A revoked retry must not create a
  // camera receipt or close the claim; a later authenticated retry may do so.
  process.env.DATA_DIR=fixture;
  db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);ensureCameraRemoteSchema(db);
  const cameraRecordingId=randomUUID(),deviceId=randomUUID(),cameraUploadId=cameraUploadIdFor(cameraRecordingId,projectId);
  db.transaction(()=>{
   claimCameraProject(db,cameraRecordingId,deviceId,projectId,100);
   recordCameraDeviceManifest(db,deviceId,cameraRecordingId,projectId,'ready',bytes.length,sha,110);
  }).immediate();
  await writeFile(join(dir,`${cameraUploadId}.mp4`),bytes,{flag:'wx'});
  db.prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(cameraUploadId,projectId,now,'video/mp4',bytes.length);
  const cameraHeaders={'X-Camera-Recording-Id':cameraRecordingId},sessionE=await login();
  const delayedCamera=await streamPaused(cameraUploadId,sessionE,false,cameraHeaders);
  await logout(sessionE);delayedCamera.finish();assert.equal((await delayedCamera.result).status,403);
  assert.equal(db.prepare('SELECT 1 FROM camera_project_upload_receipts WHERE recording_id=?').get(cameraRecordingId),undefined);
  assert.equal(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(cameraRecordingId).closed_at,null);
  assert.deepEqual(await readFile(join(dir,`${cameraUploadId}.mp4`)),bytes);
  response=await upload(cameraUploadId,sessionB,cameraHeaders);assert.equal(response.status,200);assert.equal(JSON.parse(response.body).sha256,sha);
  assert.ok(db.prepare('SELECT 1 FROM camera_project_upload_receipts WHERE recording_id=?').get(cameraRecordingId));
  assert.notEqual(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(cameraRecordingId).closed_at,null);
 } finally {db.close();}
});
