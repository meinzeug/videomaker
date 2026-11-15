import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';

const base=process.env.LIVE_RECEIPT_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3391'&&process.env.LIVE_RECEIPT_TEST_ALLOW_WRITES==='1';
test('isolated live and legacy full upload fencing keeps originals and legacy compatibility',{skip:!enabled,timeout:120000},async()=>{
 const proof=process.env.LIVE_RECORDING_FIXTURE_PROOF;
 const attest=await fetch(base+'/api/internal/live-fixture-attest');assert.equal(attest.status,200);assert.equal((await attest.json()).proof,proof);
 const bytes=readFileSync(process.env.LIVE_RECEIPT_TEST_FIXTURE+'/sample.mp4'),sha=createHash('sha256').update(bytes).digest('hex');
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
 assert.equal((await request(url,'POST',undefined,{...liveHeaders,'X-Live-Operation':'cancel'})).status,200);
 const accepted=await request(full,'POST',bytes,fullHeaders);assert.equal(accepted.status,201,JSON.stringify(accepted.value));assert.equal(accepted.value.sha256,sha);
 assert.equal((await request(full,'POST',bytes,fullHeaders)).status,200);
 const next=randomUUID(),nextProject=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:next}),{'Content-Type':'application/json'});
 const nextId=cameraUploadIdFor(next,nextProject.value.projectId);
 const denied=await request(`/api/projects/${nextProject.value.projectId}/live-recordings/${nextId}`,'POST',undefined,{'X-Recording-Id':next,'X-Live-Origin':'lan','X-Live-Operation':'begin'});
 assert.equal(denied.status,409,JSON.stringify(denied.value));assert.equal(denied.value.code,'LEGACY_HISTORY_UNVERIFIED');
 assert.equal((await request(full)).value.recordings.length,1);
});
