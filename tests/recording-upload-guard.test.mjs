import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,writeFile,utimes,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {acquireRecordingUpload,cleanupStaleRecordingUploads,parseProcStartTime,recordingUploadOwnerDefinitelyStopped,readRecordingChunk,RECORDING_DISK_RESERVE} from '../lib/recording-upload-guard.ts';

test('slots fence expired owners and reserve concurrent disk needs atomically',()=>{
 const db=new Database(':memory:');let now=1000;
 try{
  const a=acquireRecordingUpload(db,()=>now),b=acquireRecordingUpload(db,()=>now);
  assert.ok(a&&b);assert.equal(acquireRecordingUpload(db,()=>now),null);
  const need=700*1024*1024, free=RECORDING_DISK_RESERVE+BigInt(need)+100n;
  a.reserve(need,free);assert.throws(()=>b.reserve(need,free),/UPLOAD_NO_SPACE/);
  now+=46_000;const newer=acquireRecordingUpload(db,()=>now);assert.ok(newer);
  assert.throws(()=>a.check(),/UPLOAD_LEASE_LOST/);a.release();assert.equal(acquireRecordingUpload(db,()=>now)!==null,true);
 } finally {db.close();}
});
test('idle stream times out without waiting indefinitely',async()=>{
 const reader=new ReadableStream({pull(){return new Promise(()=>{});}}).getReader();
 await assert.rejects(readRecordingChunk(reader,10),/UPLOAD_TIMEOUT/);
});
test('recovery requires expired slot and definite same-namespace process death or PID reuse',()=>{
 const db=new Database(':memory:');
 try{
  const lease=acquireRecordingUpload(db),row=db.prepare('SELECT * FROM recording_upload_owners WHERE token=?').get(lease.token);
  const procStat=readFileSync('/proc/self/stat','utf8');assert.ok(parseProcStartTime(procStat,process.pid));assert.equal(parseProcStartTime(procStat,process.pid+1),null);for(const bad of ['', 'abc', '12 (name) R 1', '12 (name) '+Array(20).fill('0').join(' ')])assert.equal(parseProcStartTime(bad),null);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),false); // active lease
  db.prepare('DELETE FROM recording_upload_slots WHERE token=?').run(lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),false); // live worker after lease loss
  db.prepare("UPDATE recording_upload_owners SET process_start='' WHERE token=?").run(lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),false);
  db.prepare('UPDATE recording_upload_owners SET process_start=?,pidns=? WHERE token=?').run(row.process_start,'pid:[999999]',lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),false);
  db.prepare('UPDATE recording_upload_owners SET pidns=?,process_start=? WHERE token=?').run(row.pidns,(BigInt(row.process_start)+1n).toString(),lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),true); // live PID, different process generation
  const child=spawnSync(process.execPath,['-e','']);assert.equal(child.status,0);assert.ok(child.pid);
  db.prepare('UPDATE recording_upload_owners SET pid=?,process_start=? WHERE token=?').run(child.pid,row.process_start,lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),true); // child definitively reaped
  db.prepare("UPDATE recording_upload_owners SET host='other-host' WHERE token=?").run(lease.token);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,lease.token),false);
  assert.equal(recordingUploadOwnerDefinitelyStopped(db,randomUUID()),false);
 }finally{db.close();}
});
test('cleanup retains owner metadata while a camera upload lock references it',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-owner-')),db=new Database(':memory:');
 try{
  const lease=acquireRecordingUpload(db);db.exec('CREATE TABLE camera_project_upload_locks(upload_id TEXT PRIMARY KEY,token TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO camera_project_upload_locks VALUES(?,?)').run(randomUUID(),lease.token);lease.release();
  await cleanupStaleRecordingUploads(db,dir);assert.ok(db.prepare('SELECT 1 FROM recording_upload_owners WHERE token=?').get(lease.token));
  db.prepare('DELETE FROM camera_project_upload_locks WHERE token=?').run(lease.token);await cleanupStaleRecordingUploads(db,dir);
  assert.equal(db.prepare('SELECT 1 FROM recording_upload_owners WHERE token=?').get(lease.token),undefined);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test('cleanup removes only our inactive old temporaries with a known owner',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-guard-'));const db=new Database(':memory:');
 try{
  const owner=acquireRecordingUpload(db);const mine=path.join(dir,`.verified-upload-${owner.token}`);
  const unknown=path.join(dir,`.verified-upload-${randomUUID()}`);await writeFile(mine,'mine');await writeFile(unknown,'unknown');
  const old=new Date(Date.now()-600_000);await utimes(mine,old,old);await utimes(unknown,old,old);
  await cleanupStaleRecordingUploads(db,dir);await stat(mine);await stat(unknown);
  owner.release();await cleanupStaleRecordingUploads(db,dir);await assert.rejects(stat(mine));await stat(unknown);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
