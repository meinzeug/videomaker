// Explicit opt-in for a disposable local fixture only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const base=process.env.DELETION_TEST_SERVER,dir=process.env.DELETION_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3332'&&process.env.DELETION_TEST_ALLOW_WRITES==='1'&&typeof dir==='string'&&/^\/tmp\/deletion-recovery-e2e-[A-Za-z0-9]+$/.test(dir)&&realpathSync(dir)===dir;
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
 }finally{fixtureDb?.exec('DROP TRIGGER IF EXISTS fixture_fail_recording_delete');fixtureDb?.close();if(projectId)await req(`/api/projects/${projectId}`,{method:'DELETE'}).catch(()=>{});}
});
