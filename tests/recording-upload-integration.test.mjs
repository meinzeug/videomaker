import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

// Explicitly opt in only against a disposable localhost fixture, never production.
const base=process.env.VIDEOMAKER_UPLOAD_TEST_SERVER;
const dir=process.env.VIDEOMAKER_UPLOAD_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3334' && process.env.VIDEOMAKER_UPLOAD_TEST_ALLOW_WRITES==='1' && !!dir && dir.startsWith('/tmp/videomaker-upload-fixture-');
test('verified uploads are idempotent, conflict-safe, project-bound and survive retries',{skip:!enabled&&'Requires the isolated local fixture server.',timeout:90000},async()=>{
 let cookie='';const projects=[];
 async function req(method,url,body,extra={}){
  const headers={Origin:base,...extra};if(cookie)headers.Cookie=cookie;
  return fetch(base+url,{method,headers,body});
 }
 async function makeProject(){
  const r=await req('POST','/api/projects',JSON.stringify({title:'Upload-Test',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]}),{'Content-Type':'application/json'});
  assert.equal(r.status,201);const id=(await r.json()).id;projects.push(id);return id;
 }
 try {
  let r=await req('POST','/api/login',JSON.stringify({password:'local-upload-test-password'}),{'Content-Type':'application/json'});
  assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
  const project=await makeProject(),other=await makeProject(),recording=randomUUID(),url=`/api/projects/${project}/recordings`;
  const bytes=Buffer.from('isolated synthetic video fixture, not real media');
  const digest=createHash('sha256').update(bytes).digest('hex');
  const headers={'Content-Type':'video/mp4','X-Recording-Id':recording,'X-Content-SHA256':digest};
  r=await req('POST',url,bytes,headers);assert.equal(r.status,201);assert.deepEqual(await r.json(),{id:recording,projectId:project,sizeBytes:bytes.length,sha256:digest});
  r=await req('POST',url,bytes,{...headers,'X-Recording-Id':recording.toUpperCase()});assert.equal(r.status,200);assert.deepEqual(await r.json(),{id:recording,projectId:project,sizeBytes:bytes.length,sha256:digest});
  r=await req('POST',url,bytes,{...headers,'X-Content-SHA256':'a'.repeat(64)});assert.equal(r.status,422);
  r=await req('POST',url,Buffer.concat([bytes,Buffer.from('x')]),headers);assert.equal(r.status,409);
  r=await req('POST',`/api/projects/${other}/recordings`,bytes,headers);assert.equal(r.status,409);
  r=await req('POST',url,bytes,{...headers,'X-Recording-Id':randomUUID(),'X-Content-SHA256':'b'.repeat(64)});assert.equal(r.status,422);
  r=await req('POST',url,bytes,{...headers,'X-Recording-Id':randomUUID(),'X-Content-SHA256':'bad'});assert.equal(r.status,400);
  const old=randomUUID();r=await req('POST',url,bytes,{'Content-Type':'video/mp4','X-Recording-Id':old});assert.equal(r.status,201);
  assert.equal((await r.json()).id,old);
  r=await req('POST',url,bytes,{'Content-Type':'video/mp4','X-Recording-Id':old});assert.equal(r.status,200);
  r=await req('POST',url,Buffer.alloc(bytes.length,42),{'Content-Type':'video/mp4','X-Recording-Id':old});assert.equal(r.status,409);
  const stored=path.join(dir,'recordings',`${recording}.mp4`);assert.deepEqual(await readFile(stored),bytes);
  // Simulate a crash after durable file publication but before the SQLite commit.
  const fixtureDb=new Database(path.join(dir,'videomaker.sqlite'));fixtureDb.prepare('DELETE FROM project_recordings WHERE id=?').run(recording);fixtureDb.close();
  r=await req('POST',url,bytes,headers);assert.equal(r.status,201);assert.equal((await r.json()).sha256,digest);
  const unknown=randomUUID(),unknownFile=path.join(dir,'recordings',`${unknown}.mp4`),unknownBytes=Buffer.from('unknown owner');
  await writeFile(unknownFile,unknownBytes,{flag:'wx'});
  try {r=await req('POST',url,bytes,{...headers,'X-Recording-Id':unknown});assert.equal(r.status,409);assert.deepEqual(await readFile(unknownFile),unknownBytes);} finally {await unlink(unknownFile);}
  await writeFile(stored,Buffer.alloc(bytes.length,42));
  r=await req('POST',url,bytes,headers);assert.equal(r.status,409);
  await writeFile(stored,bytes);
  const race=randomUUID();const raceHeaders={...headers,'X-Recording-Id':race};
  const simultaneous=await Promise.all([req('POST',url,bytes,raceHeaders),req('POST',url,bytes,raceHeaders)]);
  assert.deepEqual(simultaneous.map(x=>x.status).sort(),[200,201]);
  for(const response of simultaneous)assert.equal((await response.json()).sha256,digest);
  r=await req('DELETE',`/api/projects/${project}`);assert.equal(r.status,200);projects.splice(projects.indexOf(project),1);
  r=await req('POST',url,bytes,headers);assert.equal(r.status,404);
 } finally {for(const id of projects)await req('DELETE',`/api/projects/${id}`).catch(()=>{});}
});
