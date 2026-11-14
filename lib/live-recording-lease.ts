import type Database from 'better-sqlite3';
import {acquireRecordingUpload,type RecordingLease} from './recording-upload-guard.ts';

/** A logout or deleted project cannot leave new lease metadata after authorization is revoked. */
export function acquireAuthorizedLiveLease(database:Database.Database,authorize:()=>void){
 return database.transaction(()=>{authorize();return acquireRecordingUpload(database);}).immediate();
}

/** Chunk/receipt requests own no filesystem intent or publication lock. */
export function releaseEphemeralLiveLease(database:Database.Database,lease:RecordingLease){
 database.transaction(()=>{
  lease.release();
  database.prepare('DELETE FROM recording_upload_owners WHERE token=? AND completed=1 AND NOT EXISTS (SELECT 1 FROM recording_upload_slots WHERE token=?)').run(lease.token,lease.token);
 }).immediate();
}
