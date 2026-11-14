import type Database from 'better-sqlite3';
import {runProjectRecordingDeletionBatch} from './project-recording-deletions.ts';

/** Run a bounded synchronous batch periodically; repeated jobs survive restarts. */
export function startProjectDeletionRecovery(database:()=>Database.Database,resolve:(id:string,mime:string)=>string,intervalMs=60000){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('Ungültiges Bereinigungsintervall.');
 let cursor=0,stopped=false;
 const run=()=>{
  if(stopped)return;
  try{
   const db=database();
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recording_deletions'").get()){cursor=0;return;}
   const result=runProjectRecordingDeletionBatch(db,resolve,cursor,25);
   cursor=result.pending?result.nextRowId:0;
   if(result.errors)console.error('Aufnahmebereinigung fehlgeschlagen; offener Auftrag wird erneut versucht.');
  }catch{console.error('Aufnahmebereinigung vorübergehend nicht verfügbar; erneuter Versuch folgt.');}
 };
 const timer=setInterval(run,intervalMs);timer.unref();queueMicrotask(run);
 return {run,stop:()=>{stopped=true;clearInterval(timer);}};
}
