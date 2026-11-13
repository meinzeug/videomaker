import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,writeFile,utimes,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireRecordingUpload,cleanupStaleRecordingUploads,readRecordingChunk,RECORDING_DISK_RESERVE} from '../lib/recording-upload-guard.ts';

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
