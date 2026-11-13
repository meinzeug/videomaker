import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Explicit opt-in only against our local disposable fixture server and database.
const base=process.env.VIDEOMAKER_UPLOAD_TEST_SERVER,dir=process.env.VIDEOMAKER_UPLOAD_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3334'&&process.env.VIDEOMAKER_UPLOAD_TEST_ALLOW_WRITES==='1'&&!!dir&&dir.startsWith('/tmp/videomaker-upload-fault-fixture-');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForSlot(db,recordings,requireTemp){
 for(let i=0;i<200;i++){
  const slot=db.prepare('SELECT token FROM recording_upload_slots LIMIT 1').get();
  if(slot&&(!requireTemp||existsSync(path.join(recordings,`.verified-upload-${slot.token}`))))return slot.token;
  await pause(50);
 }
 throw new Error('Fixture upload did not acquire its slot.');
}
test('fsync and lease loss never produce a false receipt and are recoverable', {skip:!enabled&&'Requires isolated fault-injected fixture.',timeout:90000},async()=>{
 const recordingDir=path.join(dir,'recordings');await mkdir(recordingDir,{recursive:true,mode:0o700});
 let cookie='',projectId='',db;
 const req=(method,url,body,headers={})=>fetch(base+url,{method,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body})});
 try{
  let response=await req('POST','/api/login',JSON.stringify({password:'local-upload-test-password'}),{'Content-Type':'application/json'});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  response=await req('POST','/api/projects',JSON.stringify({title:'Fault fixture',script:'Synthetic',sources:[],titles:[],thumbnail:'',broll:[]}),{'Content-Type':'application/json'});assert.equal(response.status,201);projectId=(await response.json()).id;
  db=new Database(path.join(dir,'videomaker.sqlite'),{timeout:5000});
  const url=`/api/projects/${projectId}/recordings`,bytes=Buffer.from('synthetic recording bytes used only for controlled fault tests'),sha256=createHash('sha256').update(bytes).digest('hex');
  const id=randomUUID(),headers={'Content-Type':'video/mp4','X-Recording-Id':id,'X-Content-SHA256':sha256};
  // Throw only after the final target was hard-linked, before its directory fsync.
  const trigger=path.join(recordingDir,'.test-fail-linked-file-fsync');await writeFile(trigger,id,{flag:'wx'});
  response=await req('POST',url,bytes,headers);assert.equal(response.status,500);
  await assert.rejects(access(trigger));
  const finalFile=path.join(recordingDir,`${id}.mp4`);assert.deepEqual(await readFile(finalFile),bytes);
  assert.equal(db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(id),undefined);
  const intent=JSON.parse(await readFile(path.join(recordingDir,`.upload-intent-${id}.json`),'utf8'));assert.equal(intent.sha256,sha256);assert.equal(intent.projectId,projectId);
  response=await req('POST',url,bytes,headers);assert.equal(response.status,201);assert.equal((await response.json()).sha256,sha256);
  assert.deepEqual(await readFile(finalFile),bytes);
  // Remove the live slot while the first body chunk is being read. A later chunk
  // must fail the fence and neither claim a receipt nor publish a new recording.
  async function loseLease(recordingId,existing){
   const first=bytes.subarray(0,Math.floor(bytes.length/2)),last=bytes.subarray(first.length);let controller;
   const body=new ReadableStream({start(c){controller=c;c.enqueue(first);}});
   const promise=fetch(base+url,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'video/mp4','Content-Length':String(bytes.length),'X-Recording-Id':recordingId,'X-Content-SHA256':sha256},body,duplex:'half'});
   const token=await waitForSlot(db,recordingDir,!existing);
   assert.equal(db.prepare('DELETE FROM recording_upload_slots WHERE token=?').run(token).changes,1);
   controller.enqueue(last);controller.close();
   const result=await promise;assert.equal(result.status,408);assert.match((await result.json()).error,/unterbrochen/);
  }
  const interrupted=randomUUID();await loseLease(interrupted,false);
  assert.equal(db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(interrupted),undefined);
  await assert.rejects(access(path.join(recordingDir,`${interrupted}.mp4`)));
  await loseLease(id,true);assert.deepEqual(await readFile(finalFile),bytes);
  response=await req('POST',url,bytes,headers);assert.equal(response.status,200);assert.equal((await response.json()).sha256,sha256);
 } finally {
  db?.close();if(projectId)await req('DELETE',`/api/projects/${projectId}`).catch(()=>{});
 }
});
