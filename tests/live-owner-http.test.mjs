import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,realpathSync,writeFileSync,unlinkSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,cameraUploadIdFor} from '../lib/camera-project-claims.ts';

const base=process.env.LIVE_RECEIPT_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3391'&&process.env.LIVE_RECEIPT_TEST_ALLOW_WRITES==='1';
test('isolated live and legacy full upload fencing keeps originals and legacy compatibility',{skip:!enabled,timeout:120000},async()=>{
 const proof=process.env.LIVE_RECORDING_FIXTURE_PROOF;
 const attest=await fetch(base+'/api/internal/live-fixture-attest');assert.equal(attest.status,200);assert.equal((await attest.json()).proof,proof);
 const root=realpathSync(process.env.LIVE_RECEIPT_TEST_FIXTURE||'');
 assert.equal(dirname(root),realpathSync(homedir()));assert.match(basename(root),/^\.videomaker-live-http\.[a-zA-Z0-9]+$/);
 assert.equal(readFileSync(join(root,'.fixture'),'utf8'),'isolated-live-http\n');
 const bytes=readFileSync(join(root,'sample.mp4')),sha=createHash('sha256').update(bytes).digest('hex');
 let cookie='';
 async function request(url,method='GET',body,headers={}){
  const res=await fetch(base+url,{method,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body})});
  const text=await res.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  return {status:res.status,value,headers:res.headers};
 }
 const login=await request('/api/login','POST',JSON.stringify({password:'isolated-live-test'}),{'Content-Type':'application/json'});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';',1)[0];
 const recording=randomUUID(),imported=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:recording}),{'Content-Type':'application/json'});
 assert.equal(imported.status,201);const project=imported.value.projectId,id=cameraUploadIdFor(recording,project),url=`/api/projects/${project}/live-recordings/${id}`;
 const liveHeaders={'X-Recording-Id':recording,'X-Live-Origin':'lan'};
 assert.equal((await request(url,'POST',undefined,{...liveHeaders,'X-Live-Operation':'begin'})).status,200);
 const oldId=randomUUID(),full=`/api/projects/${project}/recordings`;
 const fullHeaders={'Content-Type':'video/mp4','X-Recording-Id':oldId,'X-Content-SHA256':sha};
 const blocked=await request(full,'POST',bytes,fullHeaders);assert.equal(blocked.status,409,JSON.stringify(blocked.value));assert.equal(blocked.value.code,'camera_upload_busy');
 const explicit=await request(full,'POST',bytes,{'Content-Type':'video/mp4','X-Recording-Id':id,'X-Lan-Recording-Id':recording,'X-Content-SHA256':sha});assert.equal(explicit.status,409);
 const other=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:randomUUID()}),{'Content-Type':'application/json'});assert.equal(other.status,201);
 const otherProject=other.value.projectId,webId=cameraUploadIdFor(recording,otherProject);
 // Seed only this marked synthetic DB with an inconsistent restored web mapping.
 // The real HTTP route must still reject its authenticated device-claim upload.
 const synthetic=new Database(join(root,'videomaker.sqlite'),{fileMustExist:true});
 try{
  synthetic.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
  synthetic.transaction(()=>{
   synthetic.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)').run(webId,recording,otherProject);
   synthetic.prepare("INSERT INTO camera_project_device_manifests(recording_id,project_id,device_id,phase,size,sha256,observed_at) VALUES(?,?,?,'ready',?,?,?)").run(recording,otherProject,randomUUID(),bytes.length,sha,1);
  }).immediate();
 }finally{synthetic.close();}
 const web=await request(`/api/projects/${otherProject}/recordings`,'POST',bytes,{'Content-Type':'video/mp4','X-Recording-Id':webId,'X-Camera-Recording-Id':recording,'X-Content-SHA256':sha});
 assert.equal(web.status,409,JSON.stringify(web.value));assert.equal(web.value.code,'camera_upload_busy');
 assert.equal((await request(url,'POST',undefined,{...liveHeaders,'X-Live-Operation':'cancel'})).status,200);
 // An old Android app may already have completed a deterministic LAN upload
 // without the new identity header. A new app's retry must verify, not overwrite it.
 const legacyTake=randomUUID(),legacyProjectResult=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:legacyTake}),{'Content-Type':'application/json'});
 assert.equal(legacyProjectResult.status,201);const legacyProject=legacyProjectResult.value.projectId,legacyUploadId=cameraUploadIdFor(legacyTake,legacyProject);
 const legacyUrl=`/api/projects/${legacyProject}/recordings`,legacyHeaders={'Content-Type':'video/mp4','X-Recording-Id':legacyUploadId,'X-Content-SHA256':sha};
 assert.equal((await request(legacyUrl,'POST',bytes,legacyHeaders)).status,201);
 const failedBytes=Buffer.from(bytes);failedBytes[failedBytes.length-1]^=1;
 assert.equal((await request(legacyUrl,'POST',failedBytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake})).status,422);
 const probeTake=randomUUID(),probeProject=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:probeTake}),{'Content-Type':'application/json'});
 const probeId=cameraUploadIdFor(probeTake,probeProject.value.projectId);
 const probeUrl=`/api/projects/${probeProject.value.projectId}/live-recordings/${probeId}`;
 const probeHeaders={'X-Recording-Id':probeTake,'X-Live-Origin':'lan'};
 const unknown=await request(probeUrl,'POST',undefined,{...probeHeaders,'X-Live-Operation':'begin'});
 assert.equal(unknown.status,409,JSON.stringify(unknown.value));assert.equal(unknown.value.code,'LEGACY_HISTORY_UNVERIFIED');
 const upgraded=await request(legacyUrl,'POST',bytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake});
 assert.equal(upgraded.status,200,JSON.stringify(upgraded.value));assert.equal(upgraded.value.sha256,sha);
 assert.equal((await request(probeUrl,'POST',undefined,{...probeHeaders,'X-Live-Operation':'begin'})).status,200);
 assert.equal((await request(probeUrl,'POST',undefined,{...probeHeaders,'X-Live-Operation':'cancel'})).status,200);
 const changed=Buffer.from(bytes);changed[changed.length-1]^=1;const changedSha=createHash('sha256').update(changed).digest('hex');
 assert.equal((await request(legacyUrl,'POST',changed,{...legacyHeaders,'X-Content-SHA256':changedSha,'X-Lan-Recording-Id':legacyTake})).status,409);
 const serverFile=join(root,'recordings',`${legacyUploadId}.mp4`);assert.deepEqual(readFileSync(serverFile),bytes);
 writeFileSync(serverFile,changed);assert.equal((await request(legacyUrl,'POST',bytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake})).status,409);
 writeFileSync(serverFile,bytes);unlinkSync(serverFile);
 assert.equal((await request(legacyUrl,'POST',bytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake})).status,500);
 writeFileSync(serverFile,bytes,{flag:'wx',mode:0o600});
 assert.equal((await request(legacyUrl,'POST',bytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake})).status,200);
 assert.equal((await request(`/api/projects/${otherProject}/recordings`,'POST',bytes,{...legacyHeaders,'X-Lan-Recording-Id':legacyTake})).status,400);
 assert.deepEqual(readFileSync(serverFile),bytes);
 const secondId=cameraUploadIdFor(legacyTake,otherProject),secondUrl=`/api/projects/${otherProject}/recordings`;
 const secondHeaders={'Content-Type':'video/mp4','X-Recording-Id':secondId,'X-Lan-Recording-Id':legacyTake,'X-Content-SHA256':sha};
 assert.equal((await request(secondUrl,'POST',changed,{...secondHeaders,'X-Content-SHA256':changedSha})).status,409);
 const second=await request(secondUrl,'POST',bytes,secondHeaders);
 assert.equal(second.status,201,JSON.stringify(second.value));assert.equal(second.value.sha256,sha);
 assert.equal((await request(secondUrl,'POST',bytes,secondHeaders)).status,200);
 assert.deepEqual(readFileSync(join(root,'recordings',`${secondId}.mp4`)),bytes);
 assert.equal((await request(legacyUrl)).value.recordings.length,1);
 const accepted=await request(full,'POST',bytes,fullHeaders);assert.equal(accepted.status,201,JSON.stringify(accepted.value));assert.equal(accepted.value.sha256,sha);
 assert.equal((await request(full,'POST',bytes,fullHeaders)).status,200);
 const next=randomUUID(),nextProject=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:next}),{'Content-Type':'application/json'});
 const nextId=cameraUploadIdFor(next,nextProject.value.projectId);
 const denied=await request(`/api/projects/${nextProject.value.projectId}/live-recordings/${nextId}`,'POST',undefined,{'X-Recording-Id':next,'X-Live-Origin':'lan','X-Live-Operation':'begin'});
 assert.equal(denied.status,409,JSON.stringify(denied.value));assert.equal(denied.value.code,'LEGACY_HISTORY_UNVERIFIED');
 assert.equal((await request(full)).value.recordings.length,1);
});
