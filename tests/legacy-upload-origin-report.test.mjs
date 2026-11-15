import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {legacyUploadOriginReport} from '../lib/legacy-upload-origin-report.ts';

test('read-only report returns counts, never identifiers or implicit assignments',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'legacy-origin-report-')),filename=path.join(root,'copy.sqlite');
 const write=new Database(filename);
 try{
  write.exec("CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT); CREATE TABLE live_upload_path_owners(upload_id TEXT); CREATE TABLE camera_project_upload_ids(upload_id TEXT); INSERT INTO project_recordings VALUES('a','p'),('b','p'),('c','q'),('d','q'); INSERT INTO live_upload_path_owners VALUES('a'),('d'); INSERT INTO camera_project_upload_ids VALUES('b'),('d');");
  assert.throws(()=>legacyUploadOriginReport(write),/READONLY_DATABASE_REQUIRED/);
 } finally {write.close();}
 const read=new Database(filename,{readonly:true,fileMustExist:true});
 try{
  assert.deepEqual(legacyUploadOriginReport(read),{total:4,withOwnerMetadata:2,withWebMetadata:2,withBothMetadata:1,withoutOriginMetadata:1});
  assert.throws(()=>read.exec('DELETE FROM project_recordings'));
 } finally {read.close();unlinkSync(filename);rmdirSync(root);}
});

test('missing mapping tables are reported as unknown without schema creation',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'legacy-origin-empty-')),filename=path.join(root,'copy.sqlite');
 const write=new Database(filename);write.exec("CREATE TABLE project_recordings(id TEXT PRIMARY KEY); INSERT INTO project_recordings VALUES('one')");write.close();
 const read=new Database(filename,{readonly:true,fileMustExist:true});
 try{
  assert.deepEqual(legacyUploadOriginReport(read),{total:1,withOwnerMetadata:0,withWebMetadata:0,withBothMetadata:0,withoutOriginMetadata:1});
  assert.equal(read.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,1);
 } finally {read.close();unlinkSync(filename);rmdirSync(root);}
});
