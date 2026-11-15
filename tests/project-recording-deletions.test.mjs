import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_RECORDING_DELETION_SCHEMA,queueProjectRecordingDeletions,drainProjectRecordingDeletions,runProjectRecordingDeletionBatch,tombstoneProjectRecordings,isRecordingTombstoned} from '../lib/project-recording-deletions.ts';
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
test('tombstone and deletion commit together, survive restart, and block reused ID but allow a new ID',()=>{
 const f=fixture();try{
  const recording={id:f.id,mime:'video/mp4'};
  assert.throws(()=>tombstoneProjectRecordings(f.db,'project-a',[recording]),/Schreibtransaktion/);
  assert.throws(()=>f.db.transaction(()=>{tombstoneProjectRecordings(f.db,'project-a',[recording]);f.db.prepare('DELETE FROM project_recordings WHERE id=?').run(f.id);throw Error('rollback');}).immediate(),/rollback/);
  assert.equal(isRecordingTombstoned(f.db,f.id),false);
  assert.ok(f.db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(f.id));
  f.db.transaction(()=>{tombstoneProjectRecordings(f.db,'project-a',[recording]);queueProjectRecordingDeletions(f.db,[recording],f.resolve);f.db.prepare('DELETE FROM project_recordings WHERE id=?').run(f.id);}).immediate();
  f.db.close();f.db=new Database(join(f.folder,'db.sqlite'));
  assert.equal(isRecordingTombstoned(f.db,f.id.toUpperCase()),true);
  assert.throws(()=>f.db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(f.id.toUpperCase(),'video/mp4'),/recording was deleted/);
  assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO project_recording_tombstones VALUES(?,?,?)').run(f.id,'other','now'),/tombstone already exists/);
  assert.throws(()=>f.db.prepare('DELETE FROM project_recording_tombstones').run(),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE project_recording_tombstones SET project_id=?').run('other'),/immutable/);
  const fresh=randomUUID();f.db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(fresh,'video/mp4');
  assert.ok(f.db.prepare('SELECT 1 FROM project_recordings WHERE id=?').get(fresh));
  drainProjectRecordingDeletions(f.db,f.resolve);assert.equal(existsSync(f.resolve(f.id)),false);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('bulk project deletion retains tombstones for missing files and rolls all marks back on failure',()=>{
 const f=fixture();try{
  const other=randomUUID();f.db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(other,'video/mp4');
  const rows=[{id:f.id,mime:'video/mp4'},{id:other,mime:'video/mp4'}];
  assert.throws(()=>f.db.transaction(()=>{tombstoneProjectRecordings(f.db,'project-a',rows);queueProjectRecordingDeletions(f.db,rows,f.resolve);throw Error('rollback');}).immediate(),/rollback/);
  assert.equal(isRecordingTombstoned(f.db,other),false);
  f.db.transaction(()=>{tombstoneProjectRecordings(f.db,'project-a',rows);queueProjectRecordingDeletions(f.db,rows,f.resolve);f.db.prepare('DELETE FROM project_recordings').run();}).immediate();
  assert.equal(isRecordingTombstoned(f.db,other),true);assert.equal(isRecordingTombstoned(f.db,f.id),true);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('all SQLite rowid aliases reject replacement without deleting tombstones',()=>{
 for(const rowid of ['-9223372036854775808','-1','0','1','2147483647','9223372036854775807']){
  for(const alias of ['rowid','_rowid_','oid']){
   const db=new Database(':memory:');try{
    db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,mime TEXT NOT NULL)');db.exec(PROJECT_RECORDING_DELETION_SCHEMA);
    db.pragma('recursive_triggers = OFF');
    const original=randomUUID(),other=randomUUID();
    db.prepare('INSERT INTO project_recording_tombstones(rowid,recording_id,project_id,deleted_at) VALUES(CAST(? AS INTEGER),?,?,?)').run(rowid,original,'project-a','now');
    assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO project_recording_tombstones(${alias},recording_id,project_id,deleted_at) VALUES(CAST(? AS INTEGER),?,?,?)`).run(rowid,other,'project-b','later'),/rowid already exists/);
    assert.throws(()=>db.prepare(`INSERT INTO project_recording_tombstones(${alias},recording_id,project_id,deleted_at) VALUES(CAST(? AS INTEGER),?,?,?) ON CONFLICT DO UPDATE SET recording_id=excluded.recording_id`).run(rowid,other,'project-b','later'),/rowid already exists|immutable/);
    assert.deepEqual(db.prepare('SELECT recording_id,project_id,deleted_at FROM project_recording_tombstones').all(),[{recording_id:original,project_id:'project-a',deleted_at:'now'}]);
    assert.throws(()=>db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(original,'video/mp4'),/recording was deleted/);
    // SQLite reports NEW.rowid = -1 for automatic allocation in BEFORE
    // INSERT; the unusual pre-existing -1 must therefore fail closed.
    if(rowid==='-1')assert.throws(()=>db.prepare('INSERT INTO project_recording_tombstones(recording_id,project_id,deleted_at) VALUES(?,?,?)').run(other,'project-b','later'),/rowid already exists/);
    else{db.prepare('INSERT INTO project_recording_tombstones(recording_id,project_id,deleted_at) VALUES(?,?,?)').run(other,'project-b','later');assert.equal(isRecordingTombstoned(db,other),true);}
   }finally{db.close();}
  }
 }
});
