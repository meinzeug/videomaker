import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {PROJECT_RECORDING_DELETION_SCHEMA,isRecordingTombstoned} from '../lib/project-recording-deletions.ts';
const worker=new URL('./fixtures/recording-tombstone-worker.mjs',import.meta.url);
test('independent writer processes serialize deletion and a competing upload', {timeout:10000},async()=>{
 const folder=mkdtempSync(join(tmpdir(),'tombstone-process-')),file=join(folder,'db.sqlite'),id=randomUUID();
 const db=new Database(file);db.pragma('journal_mode = WAL');db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,mime TEXT NOT NULL)');db.exec(PROJECT_RECORDING_DELETION_SCHEMA);db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(id,'video/mp4');
 let del,upload;
 try{
  del=fork(worker,[file,'delete',id],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
  assert.equal((await once(del,'message'))[0],'locked');
  upload=fork(worker,[file,'upload',id],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
  assert.equal((await once(upload,'message'))[0],'trying');
  const result=once(upload,'message');del.send('commit');
  assert.equal((await result)[0],'deleted');
  assert.equal(isRecordingTombstoned(db,id),true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_recordings WHERE id=?').get(id).n,0);
 }finally{del?.kill();upload?.kill();db.close();rmSync(folder,{recursive:true,force:true});}
});
test('process death before deletion commit preserves both recording and lack of tombstone',{timeout:10000},async()=>{
 const folder=mkdtempSync(join(tmpdir(),'tombstone-crash-')),file=join(folder,'db.sqlite'),id=randomUUID();
 const db=new Database(file);db.pragma('journal_mode = WAL');db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,mime TEXT NOT NULL)');db.exec(PROJECT_RECORDING_DELETION_SCHEMA);db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(id,'video/mp4');
 let child;
 try{
  child=fork(worker,[file,'delete',id],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
  assert.equal((await once(child,'message'))[0],'locked');const done=once(child,'exit');child.kill('SIGKILL');await done;
  assert.equal(isRecordingTombstoned(db,id),false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_recordings WHERE id=?').get(id).n,1);
 }finally{child?.kill();db.close();rmSync(folder,{recursive:true,force:true});}
});
