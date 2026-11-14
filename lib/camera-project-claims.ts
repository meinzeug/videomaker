import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {recordingsDir} from './recordings.ts';
import {recordingUploadOwnerDefinitelyStopped} from './recording-upload-guard.ts';

// Claim and manifest changes belong to the caller's SQLite write transaction.
export const CAMERA_PROJECT_CLAIMS_SCHEMA = `
 CREATE TABLE IF NOT EXISTS camera_project_claims (
  recording_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK(closed_at IS NULL OR closed_at >= opened_at)
 );
 CREATE INDEX IF NOT EXISTS camera_project_claims_active ON camera_project_claims(project_id,closed_at);
 CREATE TABLE IF NOT EXISTS camera_project_upload_ids (
  upload_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS camera_project_mapping_migrations (id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS camera_project_upload_locks (upload_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE);
 CREATE TRIGGER IF NOT EXISTS camera_project_upload_ids_no_delete BEFORE DELETE ON camera_project_upload_ids BEGIN SELECT RAISE(ABORT,'camera upload reservation cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_upload_ids_no_update BEFORE UPDATE ON camera_project_upload_ids BEGIN SELECT RAISE(ABORT,'camera upload reservation cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_upload_ids_insert_guard BEFORE INSERT ON camera_project_upload_ids BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_project_upload_ids m WHERE m.upload_id=NEW.upload_id OR m.recording_id=NEW.recording_id OR m.rowid=NEW.rowid) THEN RAISE(ABORT,'camera upload reservation already exists') END; END;
 CREATE TABLE IF NOT EXISTS camera_project_upload_receipts (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK(size>0), verified_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS camera_project_final_status (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('ready','partial')), observed_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS camera_project_device_manifests (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('ready','partial')),
  size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size>0 AND size<=9007199254740991),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), observed_at INTEGER NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS camera_project_device_manifests_no_delete BEFORE DELETE ON camera_project_device_manifests BEGIN SELECT RAISE(ABORT,'device manifest cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_device_manifests_no_update BEFORE UPDATE ON camera_project_device_manifests BEGIN SELECT RAISE(ABORT,'device manifest cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_device_manifests_insert_guard BEFORE INSERT ON camera_project_device_manifests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_project_device_manifests m WHERE m.recording_id=NEW.recording_id OR m.rowid=NEW.rowid) THEN RAISE(ABORT,'device manifest already exists') END; END;
 CREATE TABLE IF NOT EXISTS camera_project_failures (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('partial','error')), observed_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS camera_project_manual_resolutions (
  recording_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('partial','error')), owner_hash TEXT NOT NULL, resolved_at INTEGER NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS camera_project_manual_resolutions_no_delete BEFORE DELETE ON camera_project_manual_resolutions BEGIN SELECT RAISE(ABORT,'resolution cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_manual_resolutions_no_update BEFORE UPDATE ON camera_project_manual_resolutions BEGIN SELECT RAISE(ABORT,'resolution cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_manual_resolutions_insert_guard BEFORE INSERT ON camera_project_manual_resolutions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_project_manual_resolutions r WHERE r.recording_id=NEW.recording_id OR r.rowid=NEW.rowid) THEN RAISE(ABORT,'resolution already exists') END; END;
 CREATE TRIGGER IF NOT EXISTS camera_project_claims_no_delete BEFORE DELETE ON camera_project_claims
  BEGIN SELECT RAISE(ABORT,'camera project claims cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS camera_project_claims_immutable BEFORE UPDATE ON camera_project_claims
  BEGIN SELECT CASE WHEN NEW.recording_id IS NOT OLD.recording_id OR NEW.device_id IS NOT OLD.device_id
   OR NEW.project_id IS NOT OLD.project_id OR NEW.opened_at IS NOT OLD.opened_at
   OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
   THEN RAISE(ABORT,'invalid camera project claim change') END; END;
`;

export class CameraProjectClaimError extends Error {
 readonly code:'project'|'conflict';
 constructor(code:'project'|'conflict',message:string){super(message);this.code=code;}
}

/** Read-only overview, including claims whose camera is offline or no longer registered. */
export function listOpenCameraClaims(db:Database.Database,projectId:string){
 const rows=db.prepare(`SELECT c.recording_id AS recordingId,c.device_id AS deviceId,
  d.name AS deviceName,c.opened_at AS openedAt,
  m.phase AS manifestPhase,m.size AS manifestSize,m.sha256 AS manifestSha256,
  CASE WHEN s.phase='ready' AND f.phase IS NOT NULL THEN 'unknown'
       WHEN s.phase='ready' THEN 'ready' WHEN f.phase IS NOT NULL THEN f.phase
       WHEN s.phase='partial' THEN 'partial' ELSE 'unknown' END AS lastConfirmedPhase
  FROM camera_project_claims c
  LEFT JOIN camera_remote_devices d ON d.id=c.device_id
  LEFT JOIN camera_project_final_status s ON s.recording_id=c.recording_id AND s.project_id=c.project_id AND s.device_id=c.device_id
  LEFT JOIN camera_project_failures f ON f.recording_id=c.recording_id AND f.project_id=c.project_id AND f.device_id=c.device_id
  LEFT JOIN camera_project_device_manifests m ON m.recording_id=c.recording_id AND m.project_id=c.project_id AND m.device_id=c.device_id
  WHERE c.project_id=? AND c.closed_at IS NULL
  ORDER BY c.opened_at DESC,c.recording_id DESC LIMIT 101`).all(projectId) as {
   recordingId:string;deviceId:string;deviceName:string|null;openedAt:number;lastConfirmedPhase:'ready'|'partial'|'error'|'unknown';manifestPhase:string|null;manifestSize:number|null;manifestSha256:string|null
  }[];
 return {claims:rows.slice(0,100).map(({manifestPhase,manifestSize,manifestSha256,...claim})=>({
  ...claim,recovery:claim.lastConfirmedPhase==='ready'&&manifestPhase==='ready'&&Number.isSafeInteger(manifestSize)&&Number(manifestSize)>0&&Number(manifestSize)<=1024*1024*1024&&typeof manifestSha256==='string'&&/^[0-9a-f]{64}$/.test(manifestSha256)
   ?{sizeBytes:manifestSize as number,sha256:manifestSha256}:null,
 })),hasMore:rows.length>100};
}
function requireTransaction(db:Database.Database){
 if(!db.inTransaction)throw new Error('Kameraprojektsperre benötigt eine unmittelbare Datenbanktransaktion.');
}

/** Acquire before queuing START in the same write transaction as the command. */
export function claimCameraProject(db:Database.Database,recordingId:string,deviceId:string,projectId:string,now:number){
 requireTransaction(db);
 const prior=db.prepare('SELECT device_id AS deviceId,project_id AS projectId,closed_at AS closedAt FROM camera_project_claims WHERE recording_id=?').get(recordingId) as {deviceId:string;projectId:string;closedAt:number|null}|undefined;
 if(prior){
  if(prior.deviceId!==deviceId||prior.projectId!==projectId||prior.closedAt!==null)
   throw new CameraProjectClaimError('conflict','Aufnahme-ID ist bereits anders belegt oder abgeschlossen.');
  return false;
 }
 if(!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw new CameraProjectClaimError('project','Skript wurde nicht gefunden.');
 const uploadId=cameraUploadIdFor(recordingId,projectId);
 const oldLock=db.prepare('SELECT token FROM camera_project_upload_locks WHERE upload_id=?').get(uploadId) as {token:string}|undefined;
 if(oldLock){
  if(!recordingUploadOwnerDefinitelyStopped(db,oldLock.token))throw new CameraProjectClaimError('conflict','Die Aufnahme-ID wird bereits hochgeladen oder ihr Zustand ist ungeklärt.');
  db.prepare('DELETE FROM camera_project_upload_locks WHERE upload_id=? AND token=?').run(uploadId,oldLock.token);
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recordings'").get()&&db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE').get(uploadId))throw new CameraProjectClaimError('conflict','Die Upload-ID wird bereits verwendet.');
 const directory=recordingsDir();
 if([`.upload-intent-${uploadId}.json`,`${uploadId}.mp4`,`${uploadId}.webm`].some(name=>existsSync(path.join(directory,name))))throw new CameraProjectClaimError('conflict','Die Upload-ID ist bereits durch eine Datei belegt.');
 db.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,?)').run(recordingId,deviceId,projectId,now);
 db.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)').run(uploadId,recordingId,projectId);
 return true;
}

export class CameraUploadGateError extends Error {
 readonly gateCode:'camera_manifest_required'|'camera_manifest_pending'|'camera_manifest_mismatch'|'camera_manifest_partial'|'camera_upload_busy';
 constructor(gateCode:CameraUploadGateError['gateCode'],message:string){super(message);this.gateCode=gateCode;}
}

/** A contradictory device failure always wins over an earlier READY report. */
export function assertCameraUploadConsistent(db:Database.Database,recordingId:string){
 if(db.prepare(`SELECT 1 FROM camera_project_failures f
  JOIN camera_project_device_manifests m ON m.recording_id=f.recording_id AND m.phase='ready'
  WHERE f.recording_id=?`).get(recordingId))
  throw new CameraUploadGateError('camera_manifest_mismatch','Für diese Kameraaufnahme liegt eine widersprüchliche Fehlermeldung vor. Bitte den Zustand am Gerät prüfen.');
}

/** Serialize upload-ID validation against a competing camera START. */
export function lockAndValidateCameraUpload(db:Database.Database,token:string,uploadId:string,cameraRecordingId:string|null,projectId:string,size:number,sha256:string|null,check:()=>void){
 return db.transaction(()=>{
  check();
  const old=db.prepare('SELECT token FROM camera_project_upload_locks WHERE upload_id=?').get(uploadId) as {token:string}|undefined;
  if(old){
   // A timed-out lease alone does not prove that asynchronous filesystem work
   // in its owner has stopped. Only an explicitly completed owner is reusable.
   if(!recordingUploadOwnerDefinitelyStopped(db,old.token))throw new CameraUploadGateError('camera_upload_busy','Diese Aufnahme wird bereits übertragen oder ihr Zustand ist ungeklärt.');
   db.prepare('DELETE FROM camera_project_upload_locks WHERE upload_id=? AND token=?').run(uploadId,old.token);
  }
  const reservation=db.prepare('SELECT recording_id AS recordingId,project_id AS projectId FROM camera_project_upload_ids WHERE upload_id=?').get(uploadId) as {recordingId:string;projectId:string}|undefined;
  if(reservation&&!cameraRecordingId)throw new CameraUploadGateError('camera_manifest_required','Für diese Kameraaufnahme ist ein Gerätenachweis erforderlich.');
  if(cameraRecordingId){
   if(!reservation||reservation.recordingId!==cameraRecordingId||reservation.projectId!==projectId)throw new CameraUploadGateError('camera_manifest_mismatch','Aufnahme und Projekt passen nicht zur reservierten Kameraaufnahme.');
   assertCameraUploadConsistent(db,cameraRecordingId);
   const manifest=db.prepare('SELECT phase,size,sha256 FROM camera_project_device_manifests WHERE recording_id=? AND project_id=?').get(cameraRecordingId,projectId) as {phase:string;size:number;sha256:string}|undefined;
   if(!manifest)throw new CameraUploadGateError('camera_manifest_pending','Der Gerätenachweis liegt noch nicht vor. Bitte erneut versuchen.');
   if(manifest.phase!=='ready')throw new CameraUploadGateError('camera_manifest_partial','Eine unvollständige Aufnahme kann nicht als fertiges Video hochgeladen werden.');
   if(manifest.size!==size||manifest.sha256!==sha256)throw new CameraUploadGateError('camera_manifest_mismatch','Dateigröße oder Prüfsumme stimmen nicht mit dem Gerätenachweis überein.');
  }
  db.prepare('INSERT INTO camera_project_upload_locks(upload_id,token) VALUES(?,?)').run(uploadId,token);
 }).immediate();
}
export function releaseCameraUploadLock(db:Database.Database,token:string){db.prepare('DELETE FROM camera_project_upload_locks WHERE token=?').run(token);}

/** Existing prototype claims receive the same reservation before any upload is accepted. */
export function ensureCameraClaimUploadMappings(db:Database.Database){
 return db.transaction(()=>{
  if(db.prepare("SELECT 1 FROM camera_project_mapping_migrations WHERE id='camera-upload-id-v1'").get())return;
  const missing=db.prepare(`SELECT c.recording_id AS recordingId,c.project_id AS projectId FROM camera_project_claims c
   LEFT JOIN camera_project_upload_ids u ON u.recording_id=c.recording_id WHERE u.recording_id IS NULL`).all() as {recordingId:string;projectId:string}[];
  const insert=db.prepare('INSERT INTO camera_project_upload_ids(upload_id,recording_id,project_id) VALUES(?,?,?)');
  for(const row of missing)insert.run(cameraUploadIdFor(row.recordingId,row.projectId),row.recordingId,row.projectId);
  db.prepare("INSERT INTO camera_project_mapping_migrations(id) VALUES('camera-upload-id-v1')").run();
 }).immediate();
}

/** Must be called in the SAME write transaction before any destructive work.
 * This assertion alone does not make filesystem deletion crash-safe. */
export function assertCameraProjectDeletable(db:Database.Database,projectId:string){
 requireTransaction(db);
 if(db.prepare('SELECT 1 FROM camera_project_claims WHERE project_id=? AND closed_at IS NULL LIMIT 1').get(projectId))
  throw new CameraProjectClaimError('conflict','Das Skript wird für eine noch nicht abgeschlossene Kameraaufnahme benötigt.');
}

/** Caller must first verify terminal outcome and safe handling of the local file.
 * A command ACK, timeout, or an offline device is not sufficient evidence. */
export function closeCameraProjectClaim(db:Database.Database,recordingId:string,deviceId:string,projectId:string,now:number){
 requireTransaction(db);
 const result=db.prepare('UPDATE camera_project_claims SET closed_at=? WHERE recording_id=? AND device_id=? AND project_id=? AND closed_at IS NULL').run(now,recordingId,deviceId,projectId);
 if(result.changes!==1)throw new CameraProjectClaimError('conflict','Die offene Aufnahmezuordnung wurde nicht gefunden.');
}

/** Save only a receipt verified against the actual stored file in this request. */
/** Matches Android's versioned stable ID, binding take and selected project. */
export function cameraUploadIdFor(recordingId:string,projectId:string){
 const bytes=createHash('sha256').update(`kontraprompter-upload-v1\0${recordingId}\0${projectId}`,'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|0x80;bytes[8]=(bytes[8]&63)|0x80;const hex=bytes.toString('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function recordCameraVerifiedUpload(db:Database.Database,recordingId:string,projectId:string,uploadId:string,sha256:string,size:number,now:number){
 requireTransaction(db);
 if(cameraUploadIdFor(recordingId,projectId)!==uploadId)throw new CameraProjectClaimError('conflict','Aufnahme und Upload-ID stimmen nicht überein.');
 const claim=db.prepare('SELECT device_id AS deviceId FROM camera_project_claims WHERE recording_id=? AND project_id=? AND closed_at IS NULL').get(recordingId,projectId) as {deviceId:string}|undefined;
 if(!claim)return;
 // A failure may arrive while the file is being streamed. Recheck inside the
 // same write transaction as the receipt and claim close.
 assertCameraUploadConsistent(db,recordingId);
 const prior=db.prepare('SELECT project_id AS projectId,upload_id AS uploadId,sha256,size FROM camera_project_upload_receipts WHERE recording_id=?').get(recordingId) as {projectId:string;uploadId:string;sha256:string;size:number}|undefined;
 if(prior&&(prior.projectId!==projectId||prior.uploadId!==uploadId||prior.sha256!==sha256||prior.size!==size))throw new CameraProjectClaimError('conflict','Der vorhandene Aufnahmebeleg stimmt nicht überein.');
 if(!prior)db.prepare('INSERT INTO camera_project_upload_receipts(recording_id,project_id,upload_id,sha256,size,verified_at) VALUES(?,?,?,?,?,?)').run(recordingId,projectId,uploadId,sha256,size,now);
 closeCameraClaimAfterUpload(db,claim.deviceId,recordingId,projectId,now);
}

/** Either order is valid: the matching device status may precede or follow upload. */
export function closeCameraClaimAfterUpload(db:Database.Database,deviceId:string,recordingId:string|null,projectId:string|null,now:number){
 requireTransaction(db);
 if(!recordingId||!projectId)return;
 const claim=db.prepare(`SELECT c.opened_at AS openedAt FROM camera_project_claims c
  JOIN camera_project_upload_receipts u ON u.recording_id=c.recording_id AND u.project_id=c.project_id
  JOIN camera_project_device_manifests d ON d.device_id=c.device_id AND d.recording_id=c.recording_id AND d.project_id=c.project_id AND d.size=u.size AND d.sha256=u.sha256
  WHERE c.recording_id=? AND c.project_id=? AND c.device_id=? AND c.closed_at IS NULL
  AND d.phase='ready' AND NOT EXISTS(SELECT 1 FROM camera_project_failures f WHERE f.recording_id=c.recording_id)`).get(recordingId,projectId,deviceId) as {openedAt:number}|undefined;
 if(claim)closeCameraProjectClaim(db,recordingId,deviceId,projectId,Math.max(now,claim.openedAt));
}

/** Called only after v2 device-ticket verification in the same poll transaction. */
export function recordCameraDeviceManifest(db:Database.Database,deviceId:string,recordingId:string|null,projectId:string|null,phase:'ready'|'partial',size:number,sha256:string,now:number){
 requireTransaction(db);
 if(!Number.isSafeInteger(size)||size<=0||!/^[0-9a-f]{64}$/.test(sha256))throw new CameraProjectClaimError('conflict','Ungültiger Gerätenachweis.');
 if(!recordingId||!projectId)return;
 const previous=db.prepare('SELECT device_id AS deviceId,project_id AS projectId,phase,size,sha256 FROM camera_project_device_manifests WHERE recording_id=?').get(recordingId) as {deviceId:string;projectId:string;phase:string;size:number;sha256:string}|undefined;
 if(previous){if(previous.deviceId!==deviceId||previous.projectId!==projectId||previous.phase!==phase||previous.size!==size||previous.sha256!==sha256)throw new CameraProjectClaimError('conflict','Der Gerätenachweis für diese Aufnahme wurde geändert.');}
 else {
  const claim=db.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? AND project_id=? AND device_id=? AND closed_at IS NULL').get(recordingId,projectId,deviceId);
  if(!claim)throw new CameraProjectClaimError('conflict','Keine passende offene Kameraaufnahme für diesen Gerätenachweis.');
  db.prepare('INSERT INTO camera_project_device_manifests(recording_id,project_id,device_id,phase,size,sha256,observed_at) VALUES(?,?,?,?,?,?,?)').run(recordingId,projectId,deviceId,phase,size,sha256,now);
 }
 closeCameraClaimAfterUpload(db,deviceId,recordingId,projectId,now);
}

/** Keep the verified terminal device report even after the device returns idle. */
export function recordCameraFinalStatus(db:Database.Database,deviceId:string,recordingId:string|null,projectId:string|null,phase:'ready'|'partial',now:number){
 requireTransaction(db);
 if(!recordingId||!projectId)return;
 const claim=db.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? AND project_id=? AND device_id=? AND closed_at IS NULL').get(recordingId,projectId,deviceId);
 if(!claim)return;
 if(phase==='partial')recordCameraFailureStatus(db,deviceId,recordingId,projectId,phase,now);
 db.prepare(`INSERT INTO camera_project_final_status(recording_id,project_id,device_id,phase,observed_at) VALUES(?,?,?,?,?)
  ON CONFLICT(recording_id) DO UPDATE SET phase=excluded.phase,observed_at=excluded.observed_at
  WHERE camera_project_final_status.project_id=excluded.project_id AND camera_project_final_status.device_id=excluded.device_id`).run(recordingId,projectId,deviceId,phase,now);
 closeCameraClaimAfterUpload(db,deviceId,recordingId,projectId,now);
}

export function recordCameraFailureStatus(db:Database.Database,deviceId:string,recordingId:string|null,projectId:string|null,phase:'error'|'partial',now:number){
 requireTransaction(db);if(!recordingId||!projectId)return;
 if(!db.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? AND project_id=? AND device_id=? AND closed_at IS NULL').get(recordingId,projectId,deviceId))return;
 db.prepare(`INSERT INTO camera_project_failures(recording_id,project_id,device_id,phase,observed_at) VALUES(?,?,?,?,?)
  ON CONFLICT(recording_id) DO UPDATE SET phase=excluded.phase,observed_at=excluded.observed_at
  WHERE camera_project_failures.project_id=excluded.project_id AND camera_project_failures.device_id=excluded.device_id`).run(recordingId,projectId,deviceId,phase,now);
}

/** Explicit admin acknowledgement; no files are deleted or represented as uploaded. */
export function resolveCameraFailure(db:Database.Database,deviceId:string,recordingId:string,projectId:string,ownerHash:string,clock:{runtimeId:string;wall:number;tick:number}){
 if(![deviceId,recordingId,projectId,clock.runtimeId].every(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))||!/^[0-9a-f]{64}$/.test(ownerHash)||!Number.isSafeInteger(clock.wall)||!Number.isSafeInteger(clock.tick))throw new CameraProjectClaimError('conflict','Ungültige Aufnahmezuordnung.');
 return db.transaction(()=>{
  const old=db.prepare('SELECT project_id AS projectId,device_id AS deviceId FROM camera_project_manual_resolutions WHERE recording_id=?').get(recordingId) as {projectId:string;deviceId:string}|undefined;
  if(old){if(old.projectId!==projectId||old.deviceId!==deviceId)throw new CameraProjectClaimError('conflict','Aufnahme wurde anders aufgelöst.');return {created:false};}
  const d=db.prepare('SELECT phase,recording_id AS recordingId,runtime_id AS runtimeId,updated_at AS wall,updated_tick AS tick FROM camera_remote_devices WHERE id=?').get(deviceId) as {phase:string;recordingId:string|null;runtimeId:string;wall:number;tick:number}|undefined;
  if(!d||d.runtimeId!==clock.runtimeId||d.wall>clock.wall||d.tick>clock.tick||d.wall<=clock.wall-10000||d.tick<=clock.tick-10000)throw new CameraProjectClaimError('conflict','Kamera ist nicht erreichbar; Aufnahmezustand ist ungeklärt.');
  if(d.phase!=='idle'&&!(['error','partial'].includes(d.phase)&&d.recordingId===recordingId))throw new CameraProjectClaimError('conflict','Kamera darf während einer laufenden oder ungeklärten Aufnahme nicht freigegeben werden.');
  const failure=db.prepare(`SELECT f.phase,c.opened_at AS openedAt FROM camera_project_failures f JOIN camera_project_claims c
   ON c.recording_id=f.recording_id AND c.project_id=f.project_id AND c.device_id=f.device_id
   WHERE f.recording_id=? AND f.project_id=? AND f.device_id=? AND c.closed_at IS NULL`).get(recordingId,projectId,deviceId) as {phase:'error'|'partial';openedAt:number}|undefined;
  if(!failure||db.prepare("SELECT 1 FROM camera_project_final_status WHERE recording_id=? AND phase='ready'").get(recordingId))throw new CameraProjectClaimError('conflict','Kein bestätigter unvollständiger oder fehlgeschlagener Vorgang.');
  db.prepare('INSERT INTO camera_project_manual_resolutions(recording_id,project_id,device_id,phase,owner_hash,resolved_at) VALUES(?,?,?,?,?,?)').run(recordingId,projectId,deviceId,failure.phase,ownerHash,clock.wall);
  closeCameraProjectClaim(db,recordingId,deviceId,projectId,Math.max(clock.wall,failure.openedAt));return {created:true};
 }).immediate();
}
