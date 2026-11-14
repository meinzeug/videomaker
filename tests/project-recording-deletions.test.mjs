import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_RECORDING_DELETION_SCHEMA,queueProjectRecordingDeletions,drainProjectRecordingDeletions,runProjectRecordingDeletionBatch} from '../lib/project-recording-deletions.ts';
import {startProjectDeletionRecovery} from '../lib/project-deletion-recovery.ts';
function fixture(){const folder=mkdtempSync(join(tmpdir(),'project-delete-')),db=new Database(join(folder,'db.sqlite')),id=randomUUID();db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,mime TEXT NOT NULL)');db.exec(PROJECT_RECORDING_DELETION_SCHEMA);db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(id,'video/mp4');const resolve=(id)=>join(folder,id+'.mp4');writeFileSync(resolve(id),'original');return {folder,db,id,resolve};}
test('failed project transaction leaves original video and database row untouched',()=>{
 const f=fixture();try{
  f.db.pragma('foreign_keys = ON');f.db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
  assert.throws(()=>f.db.transaction(()=>{queueProjectRecordingDeletions(f.db,[{id:f.id,mime:'video/mp4'}],f.resolve);f.db.prepare('DELETE FROM project_recordings').run();f.db.prepare('INSERT INTO child VALUES(1)').run();}).immediate(),/FOREIGN KEY/);
  assert.equal(readFileSync(f.resolve(f.id),'utf8'),'original');assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_recordings').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_recording_deletions').get().n,0);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('committed deletion survives restart and cleanup can be repeated',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{queueProjectRecordingDeletions(f.db,[{id:f.id,mime:'video/mp4'}],f.resolve);f.db.prepare('DELETE FROM project_recordings').run();}).immediate();
  assert.ok(existsSync(f.resolve(f.id)));f.db.close();f.db=new Database(join(f.folder,'db.sqlite'));
  drainProjectRecordingDeletions(f.db,f.resolve);assert.equal(existsSync(f.resolve(f.id)),false);drainProjectRecordingDeletions(f.db,f.resolve);assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_recording_deletions').get().n,0);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('cleanup never unlinks a replaced or newly registered file',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{queueProjectRecordingDeletions(f.db,[{id:f.id,mime:'video/mp4'}],f.resolve);f.db.prepare('DELETE FROM project_recordings').run();}).immediate();
  renameSync(f.resolve(f.id),f.resolve(f.id)+'.backup');writeFileSync(f.resolve(f.id),'replacement');drainProjectRecordingDeletions(f.db,f.resolve);assert.equal(readFileSync(f.resolve(f.id),'utf8'),'replacement');
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(f.id,'video/mp4');drainProjectRecordingDeletions(f.db,f.resolve);assert.equal(readFileSync(f.resolve(f.id),'utf8'),'replacement');
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('directory fsync failure leaves a durable job; retry finishes safely',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{queueProjectRecordingDeletions(f.db,[{id:f.id,mime:'video/mp4'}],f.resolve);f.db.prepare('DELETE FROM project_recordings').run();}).immediate();
  const failed=runProjectRecordingDeletionBatch(f.db,f.resolve,0,25,()=>{throw Error('injected EIO');});
  assert.equal(failed.errors,1);assert.equal(failed.pending,1);assert.equal(existsSync(f.resolve(f.id)),false);
  f.db.close();f.db=new Database(join(f.folder,'db.sqlite'));
  const retried=runProjectRecordingDeletionBatch(f.db,f.resolve);assert.equal(retried.pending,0);assert.equal(retried.errors,0);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('background recovery retries after restart and a blocked first job cannot starve later jobs',()=>{
 const f=fixture();try{
  const ids=[f.id];for(let i=0;i<29;i++){const id=randomUUID();ids.push(id);f.db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(id,'video/mp4');writeFileSync(f.resolve(id),'fixture');}
  f.db.transaction(()=>{queueProjectRecordingDeletions(f.db,ids.map(id=>({id,mime:'video/mp4'})),f.resolve);f.db.prepare('DELETE FROM project_recordings').run();}).immediate();
  renameSync(f.resolve(f.id),f.resolve(f.id)+'.backup');writeFileSync(f.resolve(f.id),'replacement');
  f.db.close();f.db=new Database(join(f.folder,'db.sqlite'));
  const worker=startProjectDeletionRecovery(()=>f.db,f.resolve,60000);
  worker.run();worker.run();worker.run();worker.stop();
  assert.equal(readFileSync(f.resolve(f.id),'utf8'),'replacement');assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_recording_deletions').get().n,1);
  for(const id of ids.slice(1))assert.equal(existsSync(f.resolve(id)),false);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
