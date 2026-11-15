import type Database from 'better-sqlite3';
import {cameraUploadIdFor} from './camera-project-claims.ts';

/** Test-only building block. Callers must authenticate and hold the same SQLite writer lock. */
export class UploadPathOwnerError extends Error {}
const canonicalUuid=(value:unknown):value is string =>
 typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function initializeUploadPathOwners(db:Database.Database) {
 if(!db.inTransaction)throw new UploadPathOwnerError('TRANSACTION_REQUIRED');
 const synchronous=db.pragma('synchronous',{simple:true});
 const journal=db.pragma('journal_mode',{simple:true});
 if(typeof synchronous!=='number'||synchronous<2||typeof journal!=='string'||!['delete','truncate','persist','wal'].includes(journal.toLowerCase()))
  throw new UploadPathOwnerError('UNSAFE_SQLITE_DURABILITY');
 db.exec(`CREATE TABLE IF NOT EXISTS live_upload_path_owners (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL CHECK(path IN ('live','full'))
 );
 CREATE TRIGGER IF NOT EXISTS live_upload_path_owners_no_update BEFORE UPDATE ON live_upload_path_owners
 BEGIN SELECT RAISE(ABORT,'upload path ownership cannot change'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_path_owners_no_delete BEFORE DELETE ON live_upload_path_owners
 BEGIN SELECT RAISE(ABORT,'upload path ownership cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_path_owners_insert_guard BEFORE INSERT ON live_upload_path_owners
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM live_upload_path_owners o WHERE o.recording_id=NEW.recording_id OR o.upload_id=NEW.upload_id OR o.rowid=NEW.rowid)
  THEN RAISE(ABORT,'upload path ownership already exists') END; END;`);
}

/** Stable retries only; never switch modes, projects or original while ownership is unresolved. */
export function claimUploadPath(db:Database.Database,recording:unknown,project:unknown,upload:unknown,mode:unknown) {
 if(!db.inTransaction)throw new UploadPathOwnerError('TRANSACTION_REQUIRED');
 if(!canonicalUuid(recording)||!canonicalUuid(project)||!canonicalUuid(upload)||(mode!=='live'&&mode!=='full'))throw new UploadPathOwnerError('IDENTITY_REQUIRED');
 if(cameraUploadIdFor(recording,project)!==upload)throw new UploadPathOwnerError('BINDING_MISMATCH');
 initializeUploadPathOwners(db);
 // LAN path ownership must never weaken the existing separately authenticated
 // web-camera claim or the neutral LAN-project import binding.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_project_claims'").get() &&
    db.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? COLLATE NOCASE LIMIT 1').get(recording))
  throw new UploadPathOwnerError('WEB_CLAIM');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lan_capture_projects'").get()) {
  const conflict=db.prepare('SELECT 1 FROM lan_capture_projects WHERE recording_id=? COLLATE NOCASE AND (project_id IS NULL OR project_id<>?) LIMIT 1').get(recording,project);
  if(conflict)throw new UploadPathOwnerError('BINDING_MISMATCH');
 }
 const prior=db.prepare('SELECT project_id,upload_id,path FROM live_upload_path_owners WHERE recording_id=?').get(recording) as {project_id:string;upload_id:string;path:string}|undefined;
 if(prior){
  if(prior.project_id!==project||prior.upload_id!==upload||prior.path!==mode)throw new UploadPathOwnerError('OWNER_CONFLICT');
  return {created:false};
 }
 if(mode==='live')assertNoLegacyFullUpload(db,recording,project);
 // Never silently adopt an existing final object when the origin of its
 // original recording is unknown. A separate verified recovery is needed.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recordings'").get() &&
    db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE LIMIT 1').get(upload))
  throw new UploadPathOwnerError('FINAL_RECORDING_EXISTS');
 try { db.prepare('INSERT INTO live_upload_path_owners(recording_id,project_id,upload_id,path) VALUES(?,?,?,?)').run(recording,project,upload,mode); }
 catch(error) { if((error as {code?:string}).code?.startsWith('SQLITE_CONSTRAINT'))throw new UploadPathOwnerError('OWNER_CONFLICT');throw error; }
 return {created:true};
}

/** Conservative legacy check: current app upload IDs encode both take and destination. */
export function assertNoLegacyFullUpload(db:Database.Database,recording:string,project:string) {
 const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 // Existing clients can use arbitrary IDs. An already-running unidentified
 // whole-file upload cannot be proven unrelated to a newly started live take.
 if(has('camera_project_upload_locks')&&db.prepare('SELECT 1 FROM camera_project_upload_locks LIMIT 1').get())
  throw new UploadPathOwnerError('FULL_UPLOAD_IN_PROGRESS');
 const projects=new Set<string>([project]);
 if(has('projects'))for(const row of db.prepare('SELECT id AS project FROM projects LIMIT 1001').all() as {project:string}[])projects.add(row.project);
 if(has('project_recordings'))for(const row of db.prepare('SELECT DISTINCT project_id AS project FROM project_recordings LIMIT 1001').all() as {project:string}[])projects.add(row.project);
 if(projects.size>1000)throw new UploadPathOwnerError('LEGACY_AUDIT_LIMIT');
 for(const candidate of projects){
  if(!canonicalUuid(candidate))throw new UploadPathOwnerError('LEGACY_AUDIT_REQUIRED');
  const id=cameraUploadIdFor(recording,candidate);
  if(has('camera_project_upload_locks')&&db.prepare('SELECT 1 FROM camera_project_upload_locks WHERE upload_id=? COLLATE NOCASE').get(id))throw new UploadPathOwnerError('FULL_UPLOAD_IN_PROGRESS');
  if(has('project_recordings')&&db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE').get(id))throw new UploadPathOwnerError('FINAL_RECORDING_EXISTS');
 }
 if(has('project_recordings')) {
  // Legacy arbitrary upload IDs carry no recoverable source-take identity.
  // Keep live creation closed until those historical objects are audited;
  // do not guess that a random old ID is a different recording.
  const ownerJoin=has('live_upload_path_owners')?'LEFT JOIN live_upload_path_owners o ON o.upload_id=r.id COLLATE NOCASE':'';
  const webJoin=has('camera_project_upload_ids')?'LEFT JOIN camera_project_upload_ids w ON w.upload_id=r.id COLLATE NOCASE':'';
  const conditions=[ownerJoin?'o.upload_id IS NULL':'1',webJoin?'w.upload_id IS NULL':'1'].join(' AND ');
  if(db.prepare(`SELECT 1 FROM project_recordings r ${ownerJoin} ${webJoin} WHERE ${conditions} LIMIT 1`).get())
   throw new UploadPathOwnerError('LEGACY_HISTORY_UNVERIFIED');
 }
}
