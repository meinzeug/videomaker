// Explicit opt-in for a disposable local fixture only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {existsSync,realpathSync,readdirSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const base=process.env.DELETION_TEST_SERVER,dir=process.env.DELETION_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3332'&&process.env.DELETION_TEST_ALLOW_WRITES==='1'&&typeof dir==='string'&&/^\/(?:tmp|dev\/shm)\/deletion-recovery-e2e-[A-Za-z0-9]+$/.test(dir)&&realpathSync(dir)===dir;

test('deleted recording returns JSON after a streamed 4.8 MB retry',{skip:!enabled,timeout:60000},async()=>{
 let cookie='',projectId='';const id=randomUUID(),bytes=Buffer.from('synthetic recording');
 const req=(url,options={})=>fetch(base+url,{...options,headers:{origin:base,...(cookie?{cookie}:{}),...options.headers}});
 try{
  let r=await req('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'deletion-fixture'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
  r=await req('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Streaming-Fixture',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]})});assert.equal(r.status,201);projectId=(await r.json()).id;
  const target=`/api/projects/${projectId}/recordings`;
  r=await req(target,{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':id},body:bytes});assert.equal(r.status,201);
  r=await req(`${target}/${id}`,{method:'DELETE'});assert.equal(r.status,200);
  const size=4_800_000,block=Buffer.alloc(16_000,0x35);
  const response=await new Promise((resolve,reject)=>{
   const send=httpRequest(base+target,{method:'POST',headers:{origin:base,cookie,'content-type':'video/mp4','content-length':size,'x-recording-id':id}},res=>{
    let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
   });
   send.on('error',reject);
   (async()=>{try{for(let sent=0;sent<size;sent+=block.length){if(!send.write(block.subarray(0,Math.min(block.length,size-sent))))await once(send,'drain');await new Promise(resolve=>setImmediate(resolve));}send.end();}catch(error){reject(error);}})();
  });
  assert.equal(response.status,409);assert.equal(response.body.code,'recording_deleted');
  assert.equal(existsSync(path.join(dir,'recordings',`${id}.mp4`)),false);
 }finally{if(projectId)await req(`/api/projects/${projectId}`,{method:'DELETE'}).catch(()=>{});}
});
test('single-recording deletion preserves file on DB failure and completes after retry',{skip:!enabled,timeout:60000},async()=>{
 let cookie='',projectId='',fixtureDb;const id=randomUUID(),bytes=Buffer.from('synthetic local video bytes');
 const req=(url,options={})=>fetch(base+url,{...options,headers:{origin:base,...(cookie?{cookie}:{}),...options.headers}});
 try{
  let r=await req('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'deletion-fixture'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
  r=await req('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Löschtest',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]})});assert.equal(r.status,201);projectId=(await r.json()).id;
  r=await req(`/api/projects/${projectId}/recordings`,{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':id,'x-content-sha256':createHash('sha256').update(bytes).digest('hex')},body:bytes});assert.equal(r.status,201);
  const filename=path.join(dir,'recordings',`${id}.mp4`);assert.ok(existsSync(filename));fixtureDb=new Database(path.join(dir,'videomaker.sqlite'));
  fixtureDb.exec("CREATE TRIGGER fixture_fail_recording_delete BEFORE DELETE ON project_recordings BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  r=await req(`/api/projects/${projectId}/recordings/${id}`,{method:'DELETE'});assert.equal(r.status,500);
  assert.ok(existsSync(filename));assert.ok(fixtureDb.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(id));
  assert.equal(fixtureDb.prepare('SELECT count(*) AS n FROM project_recording_deletions WHERE recording_id=?').get(id).n,0);
  fixtureDb.exec('DROP TRIGGER fixture_fail_recording_delete');
  r=await req(`/api/projects/${projectId}/recordings/${id}`,{method:'DELETE'});assert.equal(r.status,200);assert.equal(existsSync(filename),false);
  assert.equal(fixtureDb.prepare('SELECT count(*) AS n FROM project_recording_deletions WHERE recording_id=?').get(id).n,0);
  r=await req(`/api/projects/${projectId}/recordings`,{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':id,'x-content-sha256':createHash('sha256').update(bytes).digest('hex')},body:bytes});
  assert.equal(r.status,409);assert.equal((await r.json()).code,'recording_deleted');assert.equal(existsSync(filename),false);
  const nextId=randomUUID();
  r=await req(`/api/projects/${projectId}/recordings`,{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':nextId,'x-content-sha256':createHash('sha256').update(bytes).digest('hex')},body:bytes});assert.equal(r.status,201);
 }finally{fixtureDb?.exec('DROP TRIGGER IF EXISTS fixture_fail_recording_delete');fixtureDb?.close();if(projectId)await req(`/api/projects/${projectId}`,{method:'DELETE'}).catch(()=>{});}
});

test('a slow upload cannot recreate an ID deleted before its commit (synthetic interleaving)',{skip:!enabled,timeout:60000},async()=>{
 let cookie='',projectId='',controller,slow;const abort=new AbortController(),id=randomUUID(),bytes=Buffer.alloc(8192,0x31),hash=createHash('sha256').update(bytes).digest('hex');
 const req=(url,options={})=>fetch(base+url,{...options,headers:{origin:base,...(cookie?{cookie}:{}),...options.headers}});
 const headers={'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':id,'x-content-sha256':hash};
 try{
  let r=await req('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'deletion-fixture'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
  r=await req('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Race-Fixture',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]})});assert.equal(r.status,201);projectId=(await r.json()).id;
  const stream=new ReadableStream({start(c){controller=c;c.enqueue(bytes.subarray(0,1024));}});
  slow=req(`/api/projects/${projectId}/recordings`,{method:'POST',headers,body:stream,duplex:'half',signal:abort.signal});
  const recordings=path.join(dir,'recordings');let ready=false;
  for(let i=0;i<100;i++){if(existsSync(recordings)&&readdirSync(recordings).some(name=>name.startsWith('.verified-upload-'))){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,'first request reached the upload body before creating the recording');
  // Concurrent uploads of one ID are already fenced. Force the relevant
  // otherwise-tiny interleaving with a synthetic row, then exercise the real
  // HTTP deletion while the first upload is still streaming.
  const fixtureDb=new Database(path.join(dir,'videomaker.sqlite'));
  try{fixtureDb.prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(id,projectId,new Date().toISOString(),'video/mp4',bytes.length);}finally{fixtureDb.close();}
  r=await req(`/api/projects/${projectId}/recordings/${id}`,{method:'DELETE'});assert.equal(r.status,200);
  controller.enqueue(bytes.subarray(1024));controller.close();
  r=await slow;assert.equal(r.status,409);assert.equal((await r.json()).code,'recording_deleted');
  const verify=new Database(path.join(dir,'videomaker.sqlite'),{readonly:true});try{assert.equal(verify.prepare('SELECT count(*) AS n FROM project_recordings WHERE id=?').get(id).n,0);assert.equal(verify.prepare('SELECT count(*) AS n FROM project_recording_tombstones WHERE recording_id=?').get(id).n,1);}finally{verify.close();}
  assert.equal(existsSync(path.join(recordings,`${id}.mp4`)),false);
 }finally{abort.abort();if(slow)await slow.catch(()=>{});if(projectId)await req(`/api/projects/${projectId}`,{method:'DELETE'}).catch(()=>{});}
});

test('deleting a project retains its recording tombstone across other projects',{skip:!enabled,timeout:60000},async()=>{
 let cookie='',first='',second='';const id=randomUUID(),bytes=Buffer.from('synthetic project-deletion video');
 const req=(url,options={})=>fetch(base+url,{...options,headers:{origin:base,...(cookie?{cookie}:{}),...options.headers}});
 const create=()=>req('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Projektlöschung',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]})});
 const upload=project=>req(`/api/projects/${project}/recordings`,{method:'POST',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':id,'x-content-sha256':createHash('sha256').update(bytes).digest('hex')},body:bytes});
 try{
  let r=await req('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'deletion-fixture'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
  r=await create();assert.equal(r.status,201);first=(await r.json()).id;r=await create();assert.equal(r.status,201);second=(await r.json()).id;
  r=await upload(first);assert.equal(r.status,201);
  r=await req(`/api/projects/${first}`,{method:'DELETE'});assert.equal(r.status,200);first='';
  r=await upload(second);assert.equal(r.status,409);assert.equal((await r.json()).code,'recording_deleted');
  assert.equal(existsSync(path.join(dir,'recordings',`${id}.mp4`)),false);
 }finally{if(first)await req(`/api/projects/${first}`,{method:'DELETE'}).catch(()=>{});if(second)await req(`/api/projects/${second}`,{method:'DELETE'}).catch(()=>{});}
});
