import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {acquireAuthorizedLiveLease} from '../lib/live-recording-lease.ts';

test('revoked sessions or deleted projects cannot create upload lease schema or metadata',()=>{
 for(const reason of ['UNAUTHORIZED','PROJECT_MISSING']){
  const db=new Database(':memory:');
  try{
   assert.throws(()=>acquireAuthorizedLiveLease(db,()=>{throw Error(reason);}),new RegExp(reason));
   assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='recording_upload_slots'").get(),undefined);
  }finally{db.close();}
 }
});
test('authorized upload lease can be acquired and released',()=>{
 const db=new Database(':memory:');try{
  const lease=acquireAuthorizedLiveLease(db,()=>{});assert.ok(lease);lease.check();lease.release();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recording_upload_slots').get().n,0);
 }finally{db.close();}
});
