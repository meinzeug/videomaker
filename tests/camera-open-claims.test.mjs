import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,listOpenCameraClaims} from '../lib/camera-project-claims.ts';
import {sessionRevokedReadOnly,revokeSession} from '../lib/session-revocations.ts';
import {readOpenCameraClaims} from '../lib/camera-claims-readonly.ts';

function fixture(){
 const db=new Database(':memory:');
 db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
 db.exec('CREATE TABLE camera_remote_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL)');
 const add=(recording,device,project,time,closed=null)=>db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at,closed_at) VALUES(?,?,?,?,?)').run(recording,device,project,time,closed);
 return {db,add};
}

test('open claims remain visible when their device is absent, and are scoped to a project',()=>{
 const {db,add}=fixture(),project=randomUUID(),other=randomUUID(),device=randomUUID(),missing=randomUUID(),ready=randomUUID(),unknown=randomUUID();
 db.prepare('INSERT INTO camera_remote_devices VALUES(?,?)').run(device,'Samsung');
 add(ready,device,project,10);add(unknown,missing,project,20);
 add(randomUUID(),device,other,30);add(randomUUID(),device,project,40,41);
 db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(ready,project,device,50);
 const before=db.prepare('SELECT total_changes() AS n').get().n, result=listOpenCameraClaims(db,project);
 assert.deepEqual(result,{claims:[
  {recordingId:unknown,deviceId:missing,deviceName:null,openedAt:20,lastConfirmedPhase:'unknown'},
  {recordingId:ready,deviceId:device,deviceName:'Samsung',openedAt:10,lastConfirmedPhase:'ready'},
 ],hasMore:false});
 assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);db.close();
});

test('conflicting ready and failure reports are shown as unknown without resolving the claim',()=>{
 const {db,add}=fixture(),project=randomUUID(),device=randomUUID(),take=randomUUID();
 add(take,device,project,1);
 db.prepare("INSERT INTO camera_project_failures VALUES(?,?,?,'error',?)").run(take,project,device,2);
 assert.equal(listOpenCameraClaims(db,project).claims[0].lastConfirmedPhase,'error');
 db.prepare("INSERT INTO camera_project_final_status VALUES(?,?,?,'ready',?)").run(take,project,device,3);
 assert.equal(listOpenCameraClaims(db,project).claims[0].lastConfirmedPhase,'unknown');
 assert.equal(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(take).closed_at,null);
 db.close();
});

test('response is bounded and discloses truncation without modifying claims',()=>{
 const {db,add}=fixture(),project=randomUUID(),device=randomUUID();
 for(let i=0;i<101;i++)add(randomUUID(),device,project,i);
 const result=listOpenCameraClaims(db,project);
 assert.equal(result.claims.length,100);assert.equal(result.hasMore,true);
 assert.equal(result.claims[0].openedAt,100);assert.equal(result.claims.at(-1).openedAt,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_claims WHERE closed_at IS NULL').get().n,101);db.close();
});

test('read-only session check fails closed when revocation schema is missing and never creates it',()=>{
 const db=new Database(':memory:'),secret='test-secret-0123456789-abcdefghijklmnop',cookie='synthetic-cookie';
 const before=db.prepare('PRAGMA schema_version').get().schema_version;
 assert.throws(()=>sessionRevokedReadOnly(db,secret,cookie),/no such table/);
 assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,before);
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='auth_session_revocations'").get().n,0);
 revokeSession(db,secret,cookie,1);
 const after=db.prepare('PRAGMA schema_version').get().schema_version;
 assert.equal(sessionRevokedReadOnly(db,secret,cookie),true);
 assert.equal(sessionRevokedReadOnly(db,secret,'different-cookie'),false);
 assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,after);db.close();
});

test('readonly claim access does not create a missing database and observes a WAL revocation',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'camera-claims-db-')),file=path.join(dir,'videomaker.sqlite');
 const secret='test-secret-0123456789-abcdefghijklmnop',cookie='synthetic-cookie',project=randomUUID();
 let writer;
 try{
  assert.deepEqual(readOpenCameraClaims(dir,cookie,secret,project,()=>false),{kind:'unauthorized'});
  assert.throws(()=>readOpenCameraClaims(dir,cookie,secret,project,()=>true));
  assert.equal(existsSync(file),false);
  writer=new Database(file);assert.equal(writer.pragma('journal_mode = WAL',{simple:true}),'wal');
  let before=writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.throws(()=>readOpenCameraClaims(dir,cookie,secret,project,()=>true),/no such table/);
  assert.deepEqual(writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),before);
  revokeSession(writer,secret,'other-cookie',1);
  before=writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.throws(()=>readOpenCameraClaims(dir,cookie,secret,project,()=>true),/no such table/);
  assert.deepEqual(writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),before);
  writer.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);writer.exec('CREATE TABLE camera_remote_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL)');
  assert.equal(readOpenCameraClaims(dir,cookie,secret,project,()=>true).kind,'ok');
  revokeSession(writer,secret,cookie,2);
  before=writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.deepEqual(readOpenCameraClaims(dir,cookie,secret,project,()=>true),{kind:'unauthorized'});
  assert.deepEqual(writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),before);
 }finally{writer?.close();rmSync(dir,{recursive:true,force:true});}
});
