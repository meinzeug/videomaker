import {randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,openSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

type RecordingIdentity={id:string;mime:string};
type PendingFile={rowId:number;jobId:string;id:string;mime:string;dev:number;ino:number};
function assertIdentity(item:RecordingIdentity){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)||!['video/mp4','video/webm'].includes(item.mime))throw new Error('Ungültige Aufnahmedatei im Löschauftrag.');
}
export const PROJECT_RECORDING_DELETION_SCHEMA=`
 CREATE TABLE IF NOT EXISTS project_recording_deletions (
  job_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, mime TEXT NOT NULL,
  dev INTEGER NOT NULL, ino INTEGER NOT NULL
 );
`;
/** Queue while holding the same write transaction that removes project rows. */
export function queueProjectRecordingDeletions(db:Database.Database,recordings:RecordingIdentity[],resolve:(id:string,mime:string)=>string){
 if(!db.inTransaction)throw new Error('Dateilöschauftrag benötigt eine Schreibtransaktion.');
 const insert=db.prepare('INSERT INTO project_recording_deletions(job_id,recording_id,mime,dev,ino) VALUES(?,?,?,?,?)');
 for(const item of recordings){
  assertIdentity(item);
  let file;
  try{file=lstatSync(resolve(item.id,item.mime));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  if(!file.isFile()||!Number.isSafeInteger(file.dev)||!Number.isSafeInteger(file.ino))throw new Error('Aufnahmedatei kann nicht sicher gelöscht werden.');
  insert.run(randomUUID(),item.id,item.mime,file.dev,file.ino);
 }
}
function syncDirectory(directory:string){const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
/** A bounded, cursor-based pass prevents one blocked job starving the queue. */
export function runProjectRecordingDeletionBatch(db:Database.Database,resolve:(id:string,mime:string)=>string,afterRowId=0,limit=25,sync=syncDirectory){
 if(!Number.isSafeInteger(afterRowId)||afterRowId<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Ungültige Bereinigungsgrenze.');
 const jobs=db.prepare('SELECT rowid AS rowId,job_id AS jobId,recording_id AS id,mime,dev,ino FROM project_recording_deletions WHERE rowid>? ORDER BY rowid LIMIT ?').all(afterRowId,limit) as PendingFile[];
 let errors=0;
 for(const job of jobs){
  try{
   assertIdentity(job);
   db.transaction(()=>{
    if(!db.prepare('SELECT 1 FROM project_recording_deletions WHERE job_id=?').get(job.jobId))return;
    if(db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE').get(job.id))return;
    const filename=resolve(job.id,job.mime);let file;
    try{file=lstatSync(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){sync(path.dirname(filename));db.prepare('DELETE FROM project_recording_deletions WHERE job_id=?').run(job.jobId);return;}throw error;}
    if(!file.isFile()||file.dev!==job.dev||file.ino!==job.ino)return;
    unlinkSync(filename);
    // If fsync or the DB commit fails, the durable job remains for a retry.
    sync(path.dirname(filename));
    db.prepare('DELETE FROM project_recording_deletions WHERE job_id=?').run(job.jobId);
   }).immediate();
  }catch{errors++;}
 }
 const pending=(db.prepare('SELECT count(*) AS n FROM project_recording_deletions').get() as {n:number}).n;
 return {pending,nextRowId:jobs.length?jobs[jobs.length-1].rowId:0,errors};
}
/** Idempotent crash recovery. Never unlink a newly registered or replaced file. */
export function drainProjectRecordingDeletions(db:Database.Database,resolve:(id:string,mime:string)=>string,limit=100){
 const result=runProjectRecordingDeletionBatch(db,resolve,0,limit);
 if(result.errors)console.error('Einige Aufnahme-Dateien konnten noch nicht bereinigt werden.');
 return result.pending;
}
