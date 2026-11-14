import type Database from 'better-sqlite3';

// At most two immutable observations per verified recording. The global
// ceiling prevents unbounded growth; a new observation is rejected, not lost.
export const CAMERA_LATE_ALERT_LIMIT=10_000;
export const CAMERA_LATE_ALERT_SCHEMA=`
 CREATE TABLE IF NOT EXISTS camera_late_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('error','partial')),
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0 AND sequence<=9007199254740991),
  observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at>=0),
  size INTEGER, sha256 TEXT,
  CHECK((phase='error' AND size IS NULL AND sha256 IS NULL) OR
   (phase='partial' AND typeof(size)='integer' AND size>0 AND size<=9007199254740991 AND typeof(sha256)='text' AND length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(recording_id,phase)
 );
 CREATE TRIGGER IF NOT EXISTS camera_late_alerts_no_update BEFORE UPDATE ON camera_late_alerts BEGIN SELECT RAISE(ABORT,'late camera alert cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS camera_late_alerts_no_delete BEFORE DELETE ON camera_late_alerts BEGIN SELECT RAISE(ABORT,'late camera alert cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS camera_late_alerts_insert_guard BEFORE INSERT ON camera_late_alerts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_late_alerts a WHERE (a.recording_id=NEW.recording_id AND a.phase=NEW.phase) OR a.id=NEW.id) THEN RAISE(ABORT,'late camera alert already exists') END;
 END;
`;

export class CameraLateAlertError extends Error {
 readonly code:'capacity'|'conflict';
 readonly report?:{deviceId:string;recordingId:string;projectId:string;phase:'error'|'partial';sequence:number;sizeBytes:number|null;sha256:string|null};
 constructor(code:'capacity'|'conflict',message:string,report?:CameraLateAlertError['report']){super(message);this.code=code;this.report=report;}
}
type Report={id:string;recordingId:string|null;projectId:string|null;phase:'error'|'partial';sequence:number;sizeBytes?:number|null;sha256?:string|null};

/** Called only inside the same transaction as the verified, replay-protected poll. */
export function recordLateCameraAlert(db:Database.Database,report:Report,authenticated:boolean,now:number,limit=CAMERA_LATE_ALERT_LIMIT):boolean{
 if(!db.inTransaction)throw new Error('Spätmeldung benötigt eine Datenbanktransaktion.');
 if(!authenticated||!report.recordingId||!report.projectId)return false;
 if(!Number.isSafeInteger(report.sequence)||report.sequence<=0||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(limit)||limit<1)throw new CameraLateAlertError('conflict','Ungültige Spätmeldung.');
 const binding={deviceId:report.id,recordingId:report.recordingId,projectId:report.projectId,phase:report.phase,sequence:report.sequence,sizeBytes:report.phase==='partial'?report.sizeBytes??null:null,sha256:report.phase==='partial'?report.sha256??null:null};
 const claim=db.prepare('SELECT closed_at AS closedAt FROM camera_project_claims WHERE recording_id=? AND project_id=? AND device_id=?').get(report.recordingId,report.projectId,report.id) as {closedAt:number|null}|undefined;
 if(!claim||claim.closedAt===null)return false;
 const verified=db.prepare(`SELECT 1 FROM camera_project_claims c
  JOIN camera_project_upload_receipts u ON u.recording_id=c.recording_id AND u.project_id=c.project_id
  JOIN camera_project_upload_ids i ON i.recording_id=c.recording_id AND i.project_id=c.project_id AND i.upload_id=u.upload_id
  JOIN camera_project_device_manifests m ON m.recording_id=c.recording_id AND m.project_id=c.project_id AND m.device_id=c.device_id AND m.phase='ready' AND m.size=u.size AND m.sha256=u.sha256
  WHERE c.recording_id=? AND c.project_id=? AND c.device_id=? AND c.closed_at IS NOT NULL`).get(report.recordingId,report.projectId,report.id);
 if(!verified)throw new CameraLateAlertError('conflict','Der abgeschlossene Aufnahmevorgang ist nicht eindeutig prüfbar. Die Meldung wurde nicht angenommen.',binding);
 const size=report.phase==='partial'?report.sizeBytes:null,sha=report.phase==='partial'?report.sha256:null;
 if(report.phase==='partial'&&(!Number.isSafeInteger(size)||Number(size)<=0||typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha)))throw new CameraLateAlertError('conflict','Ungültiger Nachweis für die Spätmeldung.');
 const old=db.prepare('SELECT project_id AS projectId,device_id AS deviceId,size,sha256 FROM camera_late_alerts WHERE recording_id=? AND phase=?').get(report.recordingId,report.phase) as {projectId:string;deviceId:string;size:number|null;sha256:string|null}|undefined;
 if(old){if(old.projectId!==report.projectId||old.deviceId!==report.id||old.size!==size||old.sha256!==sha)throw new CameraLateAlertError('conflict','Eine andere Spätmeldung ist bereits gespeichert.',binding);return true;}
 if((db.prepare('SELECT count(*) AS n FROM camera_late_alerts').get() as {n:number}).n>=limit)throw new CameraLateAlertError('capacity','Spätmeldungen sind voll. Die Meldung wurde nicht angenommen.');
 db.prepare('INSERT INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at,size,sha256) VALUES(?,?,?,?,?,?,?,?)').run(report.recordingId,report.projectId,report.id,report.phase,report.sequence,now,size,sha);
 return true;
}

/** Newest first; immutable integer keys survive VACUUM and concurrent arrivals. */
export function listCameraLateAlerts(db:Database.Database,before:number|null){
 const rows=db.prepare(`SELECT a.id AS cursor,a.recording_id AS recordingId,a.project_id AS projectId,a.device_id AS deviceId,
  a.phase,a.sequence,a.observed_at AS observedAt,a.size,a.sha256,p.title AS projectTitle
  FROM camera_late_alerts a LEFT JOIN projects p ON p.id=a.project_id
  WHERE (? IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101`).all(before,before) as {
   cursor:number;recordingId:string;projectId:string;deviceId:string;phase:'error'|'partial';sequence:number;observedAt:number;size:number|null;sha256:string|null;projectTitle:string|null
  }[];
 const page=rows.slice(0,100);
 const capacityReached=(db.prepare('SELECT count(*) AS n FROM camera_late_alerts').get() as {n:number}).n>=CAMERA_LATE_ALERT_LIMIT;
 return {alerts:page,hasMore:rows.length>100,nextBefore:rows.length>100?page[page.length-1].cursor:null,capacityReached};
}
