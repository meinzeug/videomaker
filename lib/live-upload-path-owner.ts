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
 const old=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_upload_path_owners'").get();
 const targets=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_upload_path_targets'").get();
 const manifests=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_upload_full_manifests'").get();
 if((old||targets||manifests)&&!(old&&targets&&manifests))throw new UploadPathOwnerError('OWNER_SCHEMA_REVIEW_REQUIRED');
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
  THEN RAISE(ABORT,'upload path ownership already exists') END; END;
 CREATE TABLE IF NOT EXISTS live_upload_path_targets (
  recording_id TEXT NOT NULL,project_id TEXT NOT NULL,upload_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(recording_id,project_id)
 );
 CREATE TABLE IF NOT EXISTS live_upload_full_manifests (
  recording_id TEXT PRIMARY KEY,size INTEGER NOT NULL,sha256 TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS live_upload_targets_no_update BEFORE UPDATE ON live_upload_path_targets BEGIN SELECT RAISE(ABORT,'upload target cannot change'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_targets_no_delete BEFORE DELETE ON live_upload_path_targets BEGIN SELECT RAISE(ABORT,'upload target cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_targets_insert_guard BEFORE INSERT ON live_upload_path_targets
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM live_upload_path_targets t WHERE (t.recording_id=NEW.recording_id AND t.project_id=NEW.project_id) OR t.upload_id=NEW.upload_id OR t.rowid=NEW.rowid)
  THEN RAISE(ABORT,'upload target already exists') END; END;
 CREATE TRIGGER IF NOT EXISTS live_upload_manifest_no_update BEFORE UPDATE ON live_upload_full_manifests BEGIN SELECT RAISE(ABORT,'upload manifest cannot change'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_manifest_no_delete BEFORE DELETE ON live_upload_full_manifests BEGIN SELECT RAISE(ABORT,'upload manifest cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS live_upload_manifest_insert_guard BEFORE INSERT ON live_upload_full_manifests
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM live_upload_full_manifests m WHERE m.recording_id=NEW.recording_id OR m.rowid=NEW.rowid)
  THEN RAISE(ABORT,'upload manifest already exists') END; END;`);
}

/** Stable retries only; never switch modes, projects or original while ownership is unresolved. */
export function claimUploadPath(db:Database.Database,recording:unknown,project:unknown,upload:unknown,mode:unknown,options:{allowExistingFullRetry?:boolean; size?:number; sha256?:string}={}) {
 if(!db.inTransaction)throw new UploadPathOwnerError('TRANSACTION_REQUIRED');
 if(!canonicalUuid(recording)||!canonicalUuid(project)||!canonicalUuid(upload)||(mode!=='live'&&mode!=='full'))throw new UploadPathOwnerError('IDENTITY_REQUIRED');
 if(cameraUploadIdFor(recording,project)!==upload)throw new UploadPathOwnerError('BINDING_MISMATCH');
 if(mode==='full'&&(typeof options.size!=='number'||!Number.isSafeInteger(options.size)||options.size<=0||typeof options.sha256!=='string'||!/^[0-9a-f]{64}$/.test(options.sha256)))throw new UploadPathOwnerError('MANIFEST_REQUIRED');
 initializeUploadPathOwners(db);
 // LAN path ownership must never weaken the existing separately authenticated
 // web-camera claim or the neutral LAN-project import binding.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_project_claims'").get() &&
    db.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? COLLATE NOCASE LIMIT 1').get(recording))
  throw new UploadPathOwnerError('WEB_CLAIM');
 for(const table of ['camera_project_upload_ids','camera_project_device_manifests']){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
     db.prepare(`SELECT 1 FROM ${table} WHERE recording_id=? COLLATE NOCASE LIMIT 1`).get(recording))
   throw new UploadPathOwnerError('WEB_CLAIM');
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lan_capture_projects'").get()) {
  const bindings=db.prepare('SELECT DISTINCT project_id FROM lan_capture_projects WHERE recording_id=? COLLATE NOCASE LIMIT 2').all(recording) as {project_id:string|null}[];
  if(bindings.length>1||bindings.some(row=>!canonicalUuid(row.project_id)))throw new UploadPathOwnerError('BINDING_MISMATCH');
  // A neutral LAN import identifies the take, not an exclusive destination
  // for an explicitly authenticated full-file upload. Live staging remains
  // bound to that original neutral project.
  if(mode==='live'&&bindings.length===1&&bindings[0].project_id!==project)throw new UploadPathOwnerError('BINDING_MISMATCH');
 }
 const prior=db.prepare('SELECT project_id,upload_id,path FROM live_upload_path_owners WHERE recording_id=?').get(recording) as {project_id:string;upload_id:string;path:string}|undefined;
 if(prior&&prior.path!==mode)throw new UploadPathOwnerError('OWNER_CONFLICT');
 if(prior&&mode==='live'&&(prior.project_id!==project||prior.upload_id!==upload))throw new UploadPathOwnerError('OWNER_CONFLICT');
 if(!prior&&mode==='live')assertNoLegacyFullUpload(db,recording,project);
 if(prior&&mode==='full'){
  const manifest=db.prepare('SELECT size,sha256 FROM live_upload_full_manifests WHERE recording_id=?').get(recording) as {size:number;sha256:string}|undefined;
  if(!manifest||manifest.size!==options.size||manifest.sha256!==options.sha256)throw new UploadPathOwnerError('MANIFEST_MISMATCH');
 }
 const target=db.prepare('SELECT upload_id FROM live_upload_path_targets WHERE recording_id=? AND project_id=?').get(recording,project) as {upload_id:string}|undefined;
 if(target){if(!prior||target.upload_id!==upload)throw new UploadPathOwnerError('OWNER_CONFLICT');return {created:false};}
 if(prior&&mode==='live')throw new UploadPathOwnerError('OWNER_SCHEMA_REVIEW_REQUIRED');
 // Never silently adopt an existing final object when the origin of its
 // original recording is unknown. A separate verified recovery is needed.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recordings'").get()) {
  const finals=db.prepare('SELECT project_id FROM project_recordings WHERE id=? COLLATE NOCASE LIMIT 2').all(upload) as {project_id:string}[];
  // Reservation is not a receipt: the full-upload route must still hash the
  // existing file and incoming body before it can report an idempotent retry.
  if(finals.length && !(mode==='full'&&options.allowExistingFullRetry===true&&finals.length===1&&finals[0].project_id===project))
   throw new UploadPathOwnerError('FINAL_RECORDING_EXISTS');
 }
 try {
  if(!prior){
   db.prepare('INSERT INTO live_upload_path_owners(recording_id,project_id,upload_id,path) VALUES(?,?,?,?)').run(recording,project,upload,mode);
   if(mode==='full')db.prepare('INSERT INTO live_upload_full_manifests(recording_id,size,sha256) VALUES(?,?,?)').run(recording,options.size,options.sha256);
  }
  db.prepare('INSERT INTO live_upload_path_targets(recording_id,project_id,upload_id) VALUES(?,?,?)').run(recording,project,upload);
 }
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
  const ownerJoin=has('live_upload_path_targets')?'LEFT JOIN live_upload_path_targets o ON o.upload_id=r.id COLLATE NOCASE':'';
  const webJoin=has('camera_project_upload_ids')?'LEFT JOIN camera_project_upload_ids w ON w.upload_id=r.id COLLATE NOCASE':'';
  const conditions=[ownerJoin?'o.upload_id IS NULL':'1',webJoin?'w.upload_id IS NULL':'1'].join(' AND ');
  if(db.prepare(`SELECT 1 FROM project_recordings r ${ownerJoin} ${webJoin} WHERE ${conditions} LIMIT 1`).get())
   throw new UploadPathOwnerError('LEGACY_HISTORY_UNVERIFIED');
 }
}
