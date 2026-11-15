import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';
const base=process.env.LIVE_RECEIPT_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3391'&&process.env.LIVE_RECEIPT_TEST_ALLOW_WRITES==='1';
test('isolated HTTP live upload and receipt preserve identity, logout, and deletion',{skip:!enabled,timeout:120000},async()=>{
 const root=realpathSync(process.env.LIVE_RECEIPT_TEST_FIXTURE||'');
 assert.equal(dirname(root),realpathSync(homedir()));assert.match(basename(root),/^\.videomaker-live-http\.[a-zA-Z0-9]+$/);
 assert.equal(readFileSync(join(root,'.fixture'),'utf8'),'isolated-live-http\n');
 const bytes=readFileSync(join(root,'sample.mp4')),sha=createHash('sha256').update(bytes).digest('hex');
 let cookie='';
 async function request(url,method='GET',body,headers={},session=cookie){
  const h={Origin:base,...headers};if(session)h.Cookie=session;
  const res=await fetch(base+url,{method,headers:h,...(body===undefined?{}:{body})});
  const text=await res.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:res.status,value,headers:res.headers};
 }
 async function login(){const r=await request('/api/login','POST',JSON.stringify({password:'isolated-live-test'}),{'Content-Type':'application/json'},'');assert.equal(r.status,200);return r.headers.get('set-cookie').split(';',1)[0];}
 cookie=await login();const recording=randomUUID();
 const imported=await request('/api/projects/lan-captures','POST',JSON.stringify({recordingId:recording}),{'Content-Type':'application/json'});assert.equal(imported.status,201,JSON.stringify(imported.value));
 const project=imported.value.projectId,id=cameraUploadIdFor(recording,project),url=`/api/projects/${project}/live-recordings/${id}`,common={'X-Recording-Id':recording,'X-Live-Origin':'lan'};
 assert.equal((await request(url+'?receipt=1','GET',undefined,common,'')).status,401);
 assert.equal((await request(url,'POST',undefined,{...common,Origin:'https://wrong.invalid','X-Live-Operation':'begin'})).status,403);
 assert.equal((await request(url,'POST',undefined,{...common,'X-Live-Operation':'begin'})).status,200);
 assert.equal((await request(url+'?receipt=1','GET',undefined,common)).status,404);
 const put=await request(url,'PUT',bytes,{...common,'Content-Length':String(bytes.length),'X-Live-Part':'0','X-Live-Revision':'0','X-Live-SHA256':sha});assert.equal(put.status,200,JSON.stringify(put.value));
 const final={...common,'X-Live-Finalized':'1','X-Live-Final-Size':String(bytes.length),'X-Live-Final-SHA256':sha};
 const seal=await request(url,'POST',undefined,{...final,'X-Live-Operation':'seal'});assert.equal(seal.status,200,JSON.stringify(seal.value));assert.equal(seal.value.published,false);
 assert.equal((await request(url+'?receipt=1','GET',undefined,common)).status,404);
 const commit=await request(url,'POST',undefined,{...final,'X-Live-Operation':'commit'});assert.equal(commit.status,200,JSON.stringify(commit.value));
 // Deliberately discard the commit response; retry must independently confirm stored bytes.
 const expected={id,projectId:project,recordingId:recording,sizeBytes:bytes.length,sha256:sha,published:true};
 assert.deepEqual((await request(url+'?receipt=1','GET',undefined,common)).value,expected);
 assert.deepEqual((await request(url+'?receipt=1','GET',undefined,common)).value,expected);
 assert.equal((await request(url+'?receipt=1','GET',undefined,{...common,'X-Recording-Id':randomUUID()})).status,400);
 const saved=cookie;assert.equal((await request('/api/logout','POST')).status,200);assert.equal((await request(url+'?receipt=1','GET',undefined,common,saved)).status,401);
 cookie=await login();assert.equal((await request(`/api/projects/${project}/recordings/${id}`,'DELETE')).status,200);
 assert.equal((await request(url+'?receipt=1','GET',undefined,common)).status,404);
 assert.equal((await request(url+'?receipt=1','GET',undefined,common)).status,404);
 const list=await request(`/api/projects/${project}/recordings`);assert.equal(list.status,200);assert.equal(list.value.recordings.length,0);
});
