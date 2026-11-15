import type Database from 'better-sqlite3';
import {cameraUploadIdFor} from './camera-project-claims.ts';

/** Test-only building block. Callers must authenticate and hold the same SQLite writer lock. */
export class UploadPathOwnerError extends Error {}
const canonicalUuid=(value:unknown):value is string =>
 typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function initializeUploadPathOwners(db:Database.Database) {
 if(!db.inTransaction)throw new UploadPathOwnerError('TRANSACTION_REQUIRED');
 db.exec(`CREATE TABLE IF NOT EXISTS live_upload_path_owners (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL CHECK(path IN ('live','full'))
 );
 CREATE TRIGGER IF NOT EXISTS live_upload_path_owners_no_update BEFORE UPDATE ON live_upload_path_owners
 BEGIN SELECT RAISE(ABORT,'upload path ownership cannot change'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_path_owners_no_delete BEFORE DELETE ON live_upload_path_owners
 BEGIN SELECT RAISE(ABORT,'upload path ownership cannot be deleted'); END;`);
}

/** Stable retries only; never switch modes, projects or original while ownership is unresolved. */
export function claimUploadPath(db:Database.Database,recording:unknown,project:unknown,upload:unknown,mode:unknown) {
 if(!db.inTransaction)throw new UploadPathOwnerError('TRANSACTION_REQUIRED');
 if(!canonicalUuid(recording)||!canonicalUuid(project)||!canonicalUuid(upload)||(mode!=='live'&&mode!=='full'))throw new UploadPathOwnerError('IDENTITY_REQUIRED');
 if(cameraUploadIdFor(recording,project)!==upload)throw new UploadPathOwnerError('BINDING_MISMATCH');
 initializeUploadPathOwners(db);
 const prior=db.prepare('SELECT project_id,upload_id,path FROM live_upload_path_owners WHERE recording_id=?').get(recording) as {project_id:string;upload_id:string;path:string}|undefined;
 if(prior){
  if(prior.project_id!==project||prior.upload_id!==upload||prior.path!==mode)throw new UploadPathOwnerError('OWNER_CONFLICT');
  return {created:false};
 }
 // Never silently adopt an existing final object when the origin of its
 // original recording is unknown. A separate verified recovery is needed.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recordings'").get() &&
    db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE LIMIT 1').get(upload))
  throw new UploadPathOwnerError('FINAL_RECORDING_EXISTS');
 try { db.prepare('INSERT INTO live_upload_path_owners(recording_id,project_id,upload_id,path) VALUES(?,?,?,?)').run(recording,project,upload,mode); }
 catch(error) { if((error as {code?:string}).code?.startsWith('SQLITE_CONSTRAINT'))throw new UploadPathOwnerError('OWNER_CONFLICT');throw error; }
 return {created:true};
}
