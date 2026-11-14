import type Database from 'better-sqlite3';
import {acquireRecordingUpload} from './recording-upload-guard.ts';

/** A logout or deleted project cannot leave new lease metadata after authorization is revoked. */
export function acquireAuthorizedLiveLease(database:Database.Database,authorize:()=>void){
 return database.transaction(()=>{authorize();return acquireRecordingUpload(database);}).immediate();
}
