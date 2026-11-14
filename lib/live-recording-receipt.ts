import type Database from 'better-sqlite3';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {recordingFileReceipt} from './recording-receipt.ts';
import {acquireRecordingUpload} from './recording-upload-guard.ts';
import {LiveStagingError} from './live-recording-staging.ts';

type Saved={id:string;project_id:string;recording_id:string;state:string;final_size:number;final_sha256:string;dev:string;ino:string;created_at:string;mime:string;size:number};
type Options={database:Database.Database;root:string;id:string;project:string;recording:string;authorize:()=>void;afterHash?:()=>void};
const fail=(code:string):never=>{throw new LiveStagingError(code);};

/** Read-only confirmation: it cannot publish, recreate or delete an upload. */
export async function getLiveRecordingReceipt({database,root,id,project,recording,authorize,afterHash}:Options){
 const lease=database.transaction(()=>{authorize();return acquireRecordingUpload(database);}).immediate();
 if(!lease)return fail('CAPACITY');
 const find=()=>{
  authorize();lease.check();
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_recording_stages'").get())return fail('RECEIPT_MISSING');
  const stage=database.prepare('SELECT s.*,r.created_at,r.mime,r.size FROM live_recording_stages s JOIN projects p ON p.id=s.project_id JOIN project_recordings r ON r.id=s.id AND r.project_id=s.project_id WHERE s.id=?').get(id) as Saved|undefined;
  if(!stage)return fail('RECEIPT_MISSING');
  if(stage.project_id!==project||stage.recording_id!==recording||!['sealed','published'].includes(stage.state)||stage.mime!=='video/mp4'||stage.size!==stage.final_size||!stage.final_size||!/^[a-f0-9]{64}$/.test(stage.final_sha256)||!stage.dev||!stage.ino)return fail('RECEIPT_MISSING');
  return stage;
 };
 const file=path.join(root,'recordings',`${id}.mp4`);
 try{
  const before=database.transaction(find).immediate();
  const info=lstatSync(file,{bigint:true});
  if(!info.isFile()||info.dev.toString()!==before.dev||info.ino.toString()!==before.ino||info.size!==BigInt(before.size))return fail('RECEIPT_MISSING');
  const receipt=await recordingFileReceipt(file,before.size,lease.check);
  if(receipt.sha256!==before.final_sha256)return fail('RECEIPT_MISSING');
  afterHash?.();
  return database.transaction(()=>{
   const now=find(),current=lstatSync(file,{bigint:true});
   if(now.project_id!==before.project_id||now.recording_id!==before.recording_id||now.final_size!==before.final_size||now.final_sha256!==before.final_sha256||now.created_at!==before.created_at||now.dev!==before.dev||now.ino!==before.ino||!current.isFile()||current.dev!==info.dev||current.ino!==info.ino||current.size!==info.size||current.mtimeNs!==info.mtimeNs||current.ctimeNs!==info.ctimeNs)return fail('RECEIPT_MISSING');
   return {id,projectId:project,recordingId:recording,...receipt,published:true};
  }).immediate();
 }catch(error){
  const candidate=error as NodeJS.ErrnoException;
  if(candidate.code==='ENOENT'||candidate.code==='ENOTDIR'||candidate.code==='ELOOP'||candidate.message==='STORED_FILE_INVALID'||candidate.message==='STORED_FILE_CHANGED')return fail('RECEIPT_MISSING');
  throw error;
 }finally{try{database.transaction(()=>{
  lease.release();
  // A receipt only reads an existing file and owns no upload intent or lock.
  database.prepare('DELETE FROM recording_upload_owners WHERE token=? AND completed=1 AND NOT EXISTS (SELECT 1 FROM recording_upload_slots WHERE token=?)').run(lease.token,lease.token);
 }).immediate();}catch{/* An expired lease cannot authorize a receipt. */}}
}
