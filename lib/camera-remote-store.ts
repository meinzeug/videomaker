import type Database from 'better-sqlite3';
import {CAMERA_STOP_INTENT_SCHEMA,reserveCameraStopSlot,requestCameraStopIntent,deliverCameraStopIntent,CameraStopIntentError} from './camera-stop-intent.ts';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,CameraProjectClaimError,claimCameraProject,recordCameraFinalStatus,recordCameraDeviceManifest,recordCameraFailureStatus,closeCameraProjectClaim} from './camera-project-claims.ts';
const isUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Device telemetry is authoritative; ready is a local file, never a cloud receipt. */
export type CameraPhase='idle'|'preparing'|'recording'|'finalizing'|'ready'|'partial'|'error';
export type CameraReceipt='accepted'|'duplicate'|'rejected'|'expired';
export type CameraHeartbeat={id:string;sequence:number;name:string;capability:'remote-record-v1';phase:CameraPhase;recordingId:string|null;projectId:string|null;sizeBytes:number|null;sha256:string|null;ack:{id:string;result:CameraReceipt}[]};
export type CameraRequest={id:string;type:'record_start'|'record_stop';recordingId:string;projectId:string|null};
export type CameraClock={runtimeId:string;wall:number;tick:number};
export type CameraLimits={devicesPerOwner:number;devicesTotal:number;commandsPerDevice:number;commandsTotal:number;visible:number};
export const CAMERA_LIMITS:Readonly<CameraLimits>=Object.freeze({devicesPerOwner:256,devicesTotal:10000,commandsPerDevice:1000,commandsTotal:100000,visible:100});
// /proc/uptime truncates to 10 ms; shorten the nominal 10-second deadline accordingly.
export const CAMERA_REMOTE_TTL_MS=9990;
const phases:CameraPhase[]=['idle','preparing','recording','finalizing','ready','partial','error'];
const receipts:CameraReceipt[]=['accepted','duplicate','rejected','expired'];
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const canonical=(x:string)=>x.toLowerCase();
export class CameraRemoteError extends Error { code:'invalid'|'offline'|'conflict'|'capacity'|'project'; constructor(code:CameraRemoteError['code'],message:string){super(message);this.code=code;} }
const invalid=()=>{throw new CameraRemoteError('invalid','Ungültige Kamerameldung.');};
function validClock(clock:CameraClock){if(!isUuid(clock.runtimeId)||!Number.isSafeInteger(clock.wall)||clock.wall<0||clock.wall>Number.MAX_SAFE_INTEGER-10000||!Number.isSafeInteger(clock.tick)||clock.tick<0||clock.tick>Number.MAX_SAFE_INTEGER-10000)throw new CameraRemoteError('invalid','Ungültige Serverzeit.');}
export function parseCameraHeartbeat(input:unknown):CameraHeartbeat {
 if(!record(input)||!isUuid(input.id)||!Number.isSafeInteger(input.sequence)||Number(input.sequence)<1||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\u0000-\u001f\u007f]/.test(input.name)||input.capability!=='remote-record-v1'||!phases.includes(input.phase as CameraPhase)||!Array.isArray(input.ack)||input.ack.length>32) return invalid();
 const phase=input.phase as CameraPhase,recordingId=input.recordingId,projectId=input.projectId;
 const hasManifest=phase==='ready'||phase==='partial';
 if(hasManifest?(!Number.isSafeInteger(input.sizeBytes)||Number(input.sizeBytes)<=0||typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256)):(input.sizeBytes!=null||input.sha256!=null))return invalid();
 const withoutTake=phase==='idle'||(phase==='error'&&recordingId===null);
 if(withoutTake ? recordingId!==null||projectId!==null : !isUuid(recordingId)||(projectId!==null&&!isUuid(projectId))) return invalid();
 const ack:CameraHeartbeat['ack']=[];const seen=new Set<string>();
 for(const item of input.ack){if(!record(item)||!isUuid(item.id)||!receipts.includes(item.result as CameraReceipt))return invalid();const id=canonical(item.id);if(seen.has(id))return invalid();seen.add(id);ack.push({id,result:item.result as CameraReceipt});}
 return {id:canonical(input.id),sequence:Number(input.sequence),name:input.name.trim(),capability:'remote-record-v1',phase,recordingId:typeof recordingId==='string'?canonical(recordingId):null,projectId:typeof projectId==='string'?canonical(projectId):null,sizeBytes:hasManifest?Number(input.sizeBytes):null,sha256:hasManifest?input.sha256 as string:null,ack};
}
export function parseCameraRequest(input:unknown):CameraRequest {
 if(!record(input)||!isUuid(input.id)||!isUuid(input.recordingId)||!['record_start','record_stop'].includes(String(input.type)))throw new CameraRemoteError('invalid','Ungültiger Kamerabefehl.');
 if(input.type==='record_start'?!isUuid(input.projectId):input.projectId!==undefined&&input.projectId!==null)throw new CameraRemoteError('invalid','Ungültige Projektzuordnung.');
 return {id:canonical(input.id),type:input.type as CameraRequest['type'],recordingId:canonical(input.recordingId),projectId:typeof input.projectId==='string'?canonical(input.projectId):null};
}
export const CAMERA_REMOTE_SCHEMA=`
 CREATE TABLE IF NOT EXISTS camera_remote_devices(id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0 AND sequence<=9007199254740991),name TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('idle','preparing','recording','finalizing','ready','partial','error')),recording_id TEXT,project_id TEXT,updated_at INTEGER NOT NULL,runtime_id TEXT NOT NULL,updated_tick INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS camera_remote_owner ON camera_remote_devices(owner_hash);
 CREATE TRIGGER IF NOT EXISTS camera_remote_devices_insert_guard BEFORE INSERT ON camera_remote_devices BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_remote_devices d WHERE d.id=NEW.id OR d.rowid=NEW.rowid) THEN RAISE(ABORT,'camera device already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_remote_devices_identity_guard BEFORE UPDATE ON camera_remote_devices BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.owner_hash IS NOT OLD.owner_hash OR NEW.sequence<=OLD.sequence THEN RAISE(ABORT,'invalid camera device change') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_remote_devices_no_delete BEFORE DELETE ON camera_remote_devices BEGIN SELECT RAISE(ABORT,'camera devices cannot be deleted'); END;
 CREATE TABLE IF NOT EXISTS camera_remote_commands(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('record_start','record_stop')),recording_id TEXT NOT NULL,project_id TEXT,result TEXT NOT NULL DEFAULT 'queued' CHECK(result IN ('queued','server_expired','accepted','duplicate','rejected','expired')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at=created_at+9990),runtime_id TEXT NOT NULL,created_tick INTEGER NOT NULL,expires_tick INTEGER NOT NULL CHECK(expires_tick=created_tick+9990),result_at INTEGER,observed_final_at INTEGER,delivery_known INTEGER NOT NULL DEFAULT 0,delivered_at INTEGER,CHECK((type='record_start' AND project_id IS NOT NULL) OR (type='record_stop' AND project_id IS NULL)));
 CREATE INDEX IF NOT EXISTS camera_remote_pending ON camera_remote_commands(device_id,result,expires_tick);
 CREATE INDEX IF NOT EXISTS camera_remote_expiry ON camera_remote_commands(result,runtime_id,expires_tick,created_tick);
 CREATE UNIQUE INDEX IF NOT EXISTS camera_remote_start_recording ON camera_remote_commands(recording_id) WHERE type='record_start';
 CREATE TRIGGER IF NOT EXISTS camera_remote_commands_insert_guard BEFORE INSERT ON camera_remote_commands BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_remote_commands c WHERE c.id=NEW.id OR c.rowid=NEW.rowid OR (NEW.type='record_start' AND c.type='record_start' AND c.recording_id=NEW.recording_id)) THEN RAISE(ABORT,'camera command already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_remote_commands_immutable BEFORE UPDATE ON camera_remote_commands BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id OR NEW.type IS NOT OLD.type OR NEW.recording_id IS NOT OLD.recording_id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.runtime_id IS NOT OLD.runtime_id OR NEW.created_tick IS NOT OLD.created_tick OR NEW.expires_tick IS NOT OLD.expires_tick OR (OLD.observed_final_at IS NOT NULL AND NEW.observed_final_at IS NOT OLD.observed_final_at) OR NOT (NEW.result=OLD.result OR (OLD.result='queued' AND NEW.result IN ('server_expired','accepted','duplicate','rejected','expired')) OR (OLD.result='server_expired' AND NEW.result IN ('accepted','duplicate','rejected','expired'))) THEN RAISE(ABORT,'invalid camera command change') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_remote_commands_no_delete BEFORE DELETE ON camera_remote_commands BEGIN SELECT RAISE(ABORT,'camera commands cannot be deleted'); END;
 CREATE TABLE IF NOT EXISTS camera_stop_reservations(recording_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,created_at INTEGER NOT NULL,used_at INTEGER,released_at INTEGER,CHECK(used_at IS NULL OR released_at IS NULL));
 CREATE INDEX IF NOT EXISTS camera_stop_reservations_device ON camera_stop_reservations(device_id,used_at,released_at);
 CREATE TRIGGER IF NOT EXISTS camera_stop_reservations_insert_guard BEFORE INSERT ON camera_stop_reservations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM camera_stop_reservations r WHERE r.recording_id=NEW.recording_id OR r.rowid=NEW.rowid) THEN RAISE(ABORT,'camera stop reservation already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_stop_reservations_immutable BEFORE UPDATE ON camera_stop_reservations BEGIN
  SELECT CASE WHEN NEW.recording_id IS NOT OLD.recording_id OR NEW.device_id IS NOT OLD.device_id OR NEW.created_at IS NOT OLD.created_at OR (OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at) OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at) THEN RAISE(ABORT,'invalid camera stop reservation change') END;
 END;
 CREATE TRIGGER IF NOT EXISTS camera_stop_reservations_no_delete BEFORE DELETE ON camera_stop_reservations BEGIN SELECT RAISE(ABORT,'camera stop reservations cannot be deleted'); END;
`;
export function ensureCameraRemoteSchema(db:Database.Database){
 db.exec(CAMERA_REMOTE_SCHEMA);
 db.transaction(()=>{
  const columns=db.prepare('PRAGMA table_info(camera_remote_commands)').all() as {name:string}[];
  if(!columns.some(c=>c.name==='delivery_known'))db.exec('ALTER TABLE camera_remote_commands ADD COLUMN delivery_known INTEGER NOT NULL DEFAULT 0');
  if(!columns.some(c=>c.name==='delivered_at'))db.exec('ALTER TABLE camera_remote_commands ADD COLUMN delivered_at INTEGER');
  db.exec(`CREATE TRIGGER IF NOT EXISTS camera_remote_delivery_immutable BEFORE UPDATE ON camera_remote_commands BEGIN
   SELECT CASE WHEN NEW.delivery_known IS NOT OLD.delivery_known OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS NOT OLD.delivered_at)
    OR (OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL AND (OLD.result<>'queued' OR OLD.delivery_known<>1))
    THEN RAISE(ABORT,'invalid camera delivery change') END; END;`);
 }).immediate();
 db.exec(CAMERA_STOP_INTENT_SCHEMA);db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
}
function expireCommands(db:Database.Database,clock:CameraClock){
 db.transaction(()=>{
  db.prepare("UPDATE camera_remote_commands SET result='server_expired',result_at=? WHERE result='queued' AND (runtime_id<>? OR created_tick>? OR expires_tick<=? OR created_at>? OR expires_at<=?)").run(clock.wall,clock.runtimeId,clock.tick,clock.tick,clock.wall,clock.wall);
  db.prepare(`UPDATE camera_stop_reservations SET released_at=? WHERE used_at IS NULL AND released_at IS NULL AND recording_id IN
   (SELECT recording_id FROM camera_remote_commands WHERE type='record_start' AND result='server_expired' AND delivery_known=1 AND delivered_at IS NULL)`).run(clock.wall);
  db.prepare(`UPDATE camera_project_claims SET closed_at=MAX(opened_at,?) WHERE closed_at IS NULL AND recording_id IN
   (SELECT recording_id FROM camera_remote_commands WHERE type='record_start' AND result='server_expired' AND delivery_known=1 AND delivered_at IS NULL)`).run(clock.wall);
 }).immediate();
}
export function receiveCameraHeartbeat(db:Database.Database,input:CameraHeartbeat,clock:CameraClock,ownerHash:string,limits:CameraLimits=CAMERA_LIMITS,deviceAuthenticated=false){
 validClock(clock);if(!/^[a-f0-9]{64}$/.test(ownerHash))throw new CameraRemoteError('invalid','Ungültige Kamerasitzung.');
 return db.transaction(()=>{
  const previous=db.prepare('SELECT sequence,owner_hash AS ownerHash FROM camera_remote_devices WHERE id=?').get(input.id) as {sequence:number;ownerHash:string}|undefined;
  if(previous&&previous.ownerHash!==ownerHash)throw new CameraRemoteError('conflict','Ungültige Kamerasitzung.');
  if(previous&&input.sequence<=previous.sequence)throw new CameraRemoteError('conflict','Veraltete Kamerameldung.');
  if(!previous){
   const owned=(db.prepare('SELECT count(*) AS n FROM camera_remote_devices WHERE owner_hash=?').get(ownerHash) as {n:number}).n;
   const total=(db.prepare('SELECT count(*) AS n FROM camera_remote_devices').get() as {n:number}).n;
   if(owned>=limits.devicesPerOwner||total>=limits.devicesTotal)throw new CameraRemoteError('capacity','Kamerasitzungsgrenze erreicht.');
  }
  // An ACK reports a durable device decision, not actual recording or cloud success.
  const ack=db.prepare("UPDATE camera_remote_commands SET result=?,result_at=? WHERE id=? AND device_id=? AND result IN ('queued','server_expired') AND (delivery_known=0 OR delivered_at IS NOT NULL)");
  for(const item of input.ack){
   const changed=ack.run(item.result,clock.wall,item.id,input.id);
   if(changed.changes&&(item.result==='rejected'||item.result==='expired')){
    db.prepare("UPDATE camera_stop_reservations SET released_at=? WHERE device_id=? AND used_at IS NULL AND released_at IS NULL AND recording_id IN (SELECT recording_id FROM camera_remote_commands WHERE id=? AND device_id=? AND type='record_start')").run(clock.wall,input.id,item.id,input.id);
    const claim=db.prepare(`SELECT c.recording_id AS recordingId,c.project_id AS projectId,c.opened_at AS openedAt
     FROM camera_project_claims c JOIN camera_remote_commands cmd ON cmd.recording_id=c.recording_id AND cmd.project_id=c.project_id AND cmd.device_id=c.device_id
     WHERE cmd.id=? AND cmd.device_id=? AND cmd.type='record_start' AND c.closed_at IS NULL`).get(item.id,input.id) as {recordingId:string;projectId:string;openedAt:number}|undefined;
    if(claim)closeCameraProjectClaim(db,claim.recordingId,input.id,claim.projectId,Math.max(clock.wall,claim.openedAt));
   }
  }
  if(previous)db.prepare('UPDATE camera_remote_devices SET sequence=?,name=?,phase=?,recording_id=?,project_id=?,updated_at=?,runtime_id=?,updated_tick=? WHERE id=?').run(input.sequence,input.name,input.phase,input.recordingId,input.projectId,clock.wall,clock.runtimeId,clock.tick,input.id);
  else db.prepare('INSERT INTO camera_remote_devices(id,owner_hash,sequence,name,phase,recording_id,project_id,updated_at,runtime_id,updated_tick) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.id,ownerHash,input.sequence,input.name,input.phase,input.recordingId,input.projectId,clock.wall,clock.runtimeId,clock.tick);
  reserveCameraStopSlot(db,input.id);
  if(input.phase==='ready'||input.phase==='partial'){
   if(deviceAuthenticated){try{recordCameraDeviceManifest(db,input.id,input.recordingId,input.projectId,input.phase,input.sizeBytes!,input.sha256!,clock.wall);}catch(error){if(error instanceof CameraProjectClaimError)throw new CameraRemoteError(error.code,error.message);throw error;}}
   recordCameraFinalStatus(db,input.id,input.recordingId,input.projectId,input.phase,clock.wall);
  }
  if(input.phase==='error')recordCameraFailureStatus(db,input.id,input.recordingId,input.projectId,'error',clock.wall);
  if(input.phase==='ready'||input.phase==='partial'||input.phase==='error'){
   db.prepare("UPDATE camera_remote_commands SET observed_final_at=? WHERE device_id=? AND type='record_start' AND recording_id=? AND project_id=? AND observed_final_at IS NULL").run(clock.wall,input.id,input.recordingId,input.projectId);
   db.prepare("UPDATE camera_stop_reservations SET released_at=? WHERE device_id=? AND recording_id=? AND used_at IS NULL AND released_at IS NULL AND recording_id IN (SELECT recording_id FROM camera_remote_commands WHERE device_id=? AND project_id=? AND type='record_start')").run(clock.wall,input.id,input.recordingId,input.id,input.projectId);
  }
  expireCommands(db,clock);
  const stop=deliverCameraStopIntent(db,input.id,input.phase,input.recordingId,clock.wall);
  if(stop)return [stop];
  const pending=db.prepare("SELECT id,type,recording_id AS recordingId,project_id AS projectId,MIN(expires_tick-?,expires_at-?) AS remainingMs FROM camera_remote_commands WHERE device_id=? AND result='queued' AND runtime_id=? AND created_tick<=? AND expires_tick>? AND created_at<=? AND expires_at>? ORDER BY created_tick,id LIMIT 1").all(clock.tick,clock.wall,input.id,clock.runtimeId,clock.tick,clock.tick,clock.wall,clock.wall) as {id:string}[];
  if(pending.length)db.prepare('UPDATE camera_remote_commands SET delivered_at=? WHERE id=? AND delivery_known=1 AND delivered_at IS NULL').run(clock.wall,pending[0].id);
  return pending;
 })();
}
export function queueCameraRequest(db:Database.Database,deviceId:string,request:CameraRequest,clock:CameraClock,limits:CameraLimits=CAMERA_LIMITS){
 validClock(clock);if(!isUuid(deviceId))throw new CameraRemoteError('invalid','Ungültiges Gerät.');deviceId=canonical(deviceId);expireCommands(db,clock);
 if(request.type==='record_stop'){
  try{const result=requestCameraStopIntent(db,deviceId,request.recordingId,clock);return {id:result.id,created:result.created,result:result.observed?'observed':'queued'};}
  catch(error){if(error instanceof CameraStopIntentError)throw new CameraRemoteError(error.code,error.message);throw error;}
 }
 return db.transaction(()=>{
  const prior=db.prepare('SELECT device_id AS deviceId,type,recording_id AS recordingId,project_id AS projectId,result FROM camera_remote_commands WHERE id=?').get(request.id) as {deviceId:string;type:string;recordingId:string;projectId:string|null;result:string}|undefined;
  if(prior){if(prior.deviceId!==deviceId||prior.type!==request.type||prior.recordingId!==request.recordingId||prior.projectId!==request.projectId)throw new CameraRemoteError('conflict','Befehls-ID wurde bereits anders verwendet.');return {id:request.id,created:false,result:prior.result};}
  const device=db.prepare('SELECT phase,recording_id AS recordingId,runtime_id AS runtimeId,updated_tick AS updatedTick,updated_at AS updatedAt FROM camera_remote_devices WHERE id=?').get(deviceId) as {phase:CameraPhase;recordingId:string|null;runtimeId:string;updatedTick:number;updatedAt:number}|undefined;
  if(!device||device.runtimeId!==clock.runtimeId||device.updatedTick>clock.tick||device.updatedTick<=clock.tick-10000||device.updatedAt>clock.wall||device.updatedAt<=clock.wall-10000)throw new CameraRemoteError('offline','Kamera ist nicht erreichbar.');
  if(request.type==='record_start'){
   if(device.phase!=='idle')throw new CameraRemoteError('conflict','Kamera ist für einen neuen Start nicht bereit.');
   if(!db.prepare('SELECT 1 FROM projects WHERE id=?').get(request.projectId))throw new CameraRemoteError('project','Skript wurde nicht gefunden.');
   if(db.prepare("SELECT 1 FROM camera_remote_commands WHERE type='record_start' AND recording_id=?").get(request.recordingId))throw new CameraRemoteError('conflict','Aufnahme-ID wurde bereits verwendet.');
   if(db.prepare("SELECT 1 FROM camera_remote_commands WHERE device_id=? AND type='record_start' AND result IN ('queued','server_expired','accepted','duplicate') AND observed_final_at IS NULL AND NOT (result='server_expired' AND delivery_known=1 AND delivered_at IS NULL) LIMIT 1").get(deviceId))throw new CameraRemoteError('conflict','Ein früherer Start ist noch nicht eindeutig abgeschlossen.');
  } else if(device.phase!=='recording'||device.recordingId!==request.recordingId)throw new CameraRemoteError('conflict','Die Kamera bestätigt diese laufende Aufnahme nicht.');
  if(db.prepare("SELECT 1 FROM camera_remote_commands WHERE device_id=? AND result='queued' AND runtime_id=? AND expires_tick>?").get(deviceId,clock.runtimeId,clock.tick))throw new CameraRemoteError('conflict','Kamera verarbeitet bereits einen Befehl.');
  const owned=(db.prepare('SELECT count(*) AS n FROM camera_remote_commands WHERE device_id=?').get(deviceId) as {n:number}).n;
  const total=(db.prepare('SELECT count(*) AS n FROM camera_remote_commands').get() as {n:number}).n;
  const reservedOwned=(db.prepare('SELECT count(*) AS n FROM camera_stop_reservations WHERE device_id=? AND used_at IS NULL AND released_at IS NULL').get(deviceId) as {n:number}).n;
  const reservedTotal=(db.prepare('SELECT count(*) AS n FROM camera_stop_reservations WHERE used_at IS NULL AND released_at IS NULL').get() as {n:number}).n;
  const reservation=request.type==='record_stop'?db.prepare('SELECT 1 FROM camera_stop_reservations WHERE device_id=? AND recording_id=? AND used_at IS NULL AND released_at IS NULL').get(deviceId,request.recordingId):undefined;
  const need=request.type==='record_start'?2:reservation?0:1;
  // A previously reserved first stop remains available even if limits were lowered later.
  if(!reservation&&(owned+reservedOwned+need>limits.commandsPerDevice||total+reservedTotal+need>limits.commandsTotal))throw new CameraRemoteError('capacity','Kamerabefehlsgrenze erreicht.');
  if(reservation)db.prepare('UPDATE camera_stop_reservations SET used_at=? WHERE device_id=? AND recording_id=? AND used_at IS NULL AND released_at IS NULL').run(clock.wall,deviceId,request.recordingId);
  db.prepare("INSERT INTO camera_remote_commands(id,device_id,type,recording_id,project_id,result,created_at,expires_at,runtime_id,created_tick,expires_tick,delivery_known) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,1)").run(request.id,deviceId,request.type,request.recordingId,request.projectId,clock.wall,clock.wall+CAMERA_REMOTE_TTL_MS,clock.runtimeId,clock.tick,clock.tick+CAMERA_REMOTE_TTL_MS);
  try{claimCameraProject(db,request.recordingId,deviceId,request.projectId!,clock.wall);}catch(error){if(error instanceof CameraProjectClaimError)throw new CameraRemoteError(error.code,error.message);throw error;}
  if(request.type==='record_start')db.prepare('INSERT INTO camera_stop_reservations(recording_id,device_id,created_at) VALUES(?,?,?)').run(request.recordingId,deviceId,clock.wall);
  return {id:request.id,created:true,result:'queued'};
 })();
}
export function listCameraDevices(db:Database.Database,clock:CameraClock,limits:CameraLimits=CAMERA_LIMITS){
 validClock(clock);expireCommands(db,clock);
 const rows=db.prepare('SELECT id,name,phase,recording_id AS recordingId,project_id AS projectId,updated_at AS lastSeen,MAX(?-updated_tick,?-updated_at) AS ageMs FROM camera_remote_devices WHERE runtime_id=? AND updated_tick>? AND updated_tick<=? AND updated_at>? AND updated_at<=? ORDER BY name,id LIMIT ?').all(clock.tick,clock.wall,clock.runtimeId,clock.tick-10000,clock.tick,clock.wall-10000,clock.wall,limits.visible+1) as {id:string}[];
 const hasMore=rows.length>limits.visible;
 const last=db.prepare("SELECT id,type,recording_id AS recordingId,result,(result='server_expired' AND delivery_known=1 AND delivered_at IS NULL) AS neverDelivered FROM camera_remote_commands WHERE device_id=? ORDER BY rowid DESC LIMIT 1");
 const pendingStart=db.prepare("SELECT 1 FROM camera_remote_commands WHERE device_id=? AND type='record_start' AND result IN ('queued','server_expired','accepted','duplicate') AND observed_final_at IS NULL AND NOT (result='server_expired' AND delivery_known=1 AND delivered_at IS NULL) LIMIT 1");
 const stop=db.prepare('SELECT intent_id AS id,recording_id AS recordingId,observed_at AS observedAt FROM camera_stop_intents WHERE device_id=?');
 const failure=db.prepare(`SELECT f.recording_id AS recordingId,f.project_id AS projectId,f.phase FROM camera_project_failures f
  JOIN camera_project_claims c ON c.recording_id=f.recording_id AND c.project_id=f.project_id AND c.device_id=f.device_id
  WHERE f.device_id=? AND c.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM camera_project_final_status s WHERE s.recording_id=f.recording_id AND s.phase='ready') ORDER BY f.observed_at LIMIT 1`);
 const devices=rows.slice(0,limits.visible).map(device=>{const value=last.get(device.id) as {id:string;type:string;recordingId:string;result:string}|undefined;const intent=stop.get(device.id) as {id:string|null;recordingId:string|null;observedAt:number|null}|undefined;return {...device,lastCommand:value??null,pendingStart:!!pendingStart.get(device.id),recoverableClaim:failure.get(device.id)??null,stopIntent:intent?.id?{id:intent.id,recordingId:intent.recordingId,observed:intent.observedAt!==null}:null};});
 return {devices,hasMore};
}
