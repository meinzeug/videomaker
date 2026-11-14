import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_LATE_ALERT_SCHEMA} from '../lib/camera-late-alerts.ts';
import {readCameraLateAlerts} from '../lib/camera-alerts-readonly.ts';
import {revokeSession} from '../lib/session-revocations.ts';

test('alert reads do not create storage or schema and respect WAL revocation',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'camera-alerts-readonly-')),file=path.join(dir,'videomaker.sqlite');
 const secret='test-secret-0123456789-abcdefghijklmnop',cookie='fixture-cookie';let db;
 try{
  assert.deepEqual(readCameraLateAlerts(dir,cookie,secret,null,()=>false),{kind:'unauthorized'});
  assert.throws(()=>readCameraLateAlerts(dir,cookie,secret,null,()=>true));assert.equal(existsSync(file),false);
  db=new Database(file);assert.equal(db.pragma('journal_mode=WAL',{simple:true}),'wal');
  let schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.throws(()=>readCameraLateAlerts(dir,cookie,secret,null,()=>true),/no such table/);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);
  revokeSession(db,secret,'another-cookie',1);schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.throws(()=>readCameraLateAlerts(dir,cookie,secret,null,()=>true),/no such table/);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);
  db.exec(CAMERA_LATE_ALERT_SCHEMA);db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL)');
  assert.equal(readCameraLateAlerts(dir,cookie,secret,null,()=>true).kind,'ok');
  assert.equal(readCameraLateAlerts(dir,cookie,secret,'invalid',()=>true).kind,'invalid');
  revokeSession(db,secret,cookie,2);schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.equal(readCameraLateAlerts(dir,cookie,secret,null,()=>true).kind,'unauthorized');
  assert.equal(readCameraLateAlerts(dir,cookie,secret,'invalid',()=>true).kind,'unauthorized');
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
