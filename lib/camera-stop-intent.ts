import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {CameraClock, CameraPhase} from './camera-remote-store';

const DELIVERY_TTL_MS = 9990;
export class CameraStopIntentError extends Error {
 readonly code:'offline'|'conflict';
 constructor(code:'offline'|'conflict', message:string) { super(message); this.code=code; }
}

// Internal v2 building block only: no route calls this until device identity,
// replay-safe retention and project deletion are integrated and tested.
export const CAMERA_STOP_INTENT_SCHEMA = `
 CREATE TABLE IF NOT EXISTS camera_stop_intents (
  device_id TEXT PRIMARY KEY REFERENCES camera_remote_devices(id),
  recording_id TEXT, intent_id TEXT, observed_at INTEGER,
  CHECK ((recording_id IS NULL AND intent_id IS NULL AND observed_at IS NULL)
      OR (recording_id IS NOT NULL AND intent_id IS NOT NULL))
 );
`;

/** Must run in the same transaction as device registration. One bounded slot per device. */
export function reserveCameraStopSlot(db: Database.Database, deviceId: string) {
 const result = db.prepare('INSERT OR IGNORE INTO camera_stop_intents(device_id) SELECT id FROM camera_remote_devices WHERE id=?').run(deviceId);
 if (!result.changes && !db.prepare('SELECT 1 FROM camera_stop_intents WHERE device_id=?').get(deviceId))
  throw new CameraStopIntentError('conflict', 'Kamera ist nicht registriert.');
}

// A recording-specific, stable ID means retries and process restarts cannot
// turn one stop intent into many commands or target a different recording.
export function cameraStopIntentId(deviceId: string, recordingId: string) {
 const bytes = createHash('sha256').update('videomaker-camera-stop/v2\0').update(deviceId).update('\0').update(recordingId).digest().subarray(0, 16);
 bytes[6] = (bytes[6] & 15) | 0x80; // UUIDv8, application-defined
 bytes[8] = (bytes[8] & 63) | 0x80;
 const hex = bytes.toString('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

type Slot = {recordingId:string|null; intentId:string|null; observedAt:number|null};
type Device = {phase:CameraPhase; recordingId:string|null; runtimeId:string; updatedTick:number; updatedAt:number};

/** Request the exact currently reported take. ACK and HTTP success do not prove it stopped. */
export function requestCameraStopIntent(db: Database.Database, deviceId:string, recordingId:string, clock:CameraClock) {
 return db.transaction(() => {
  const device = db.prepare('SELECT phase,recording_id AS recordingId,runtime_id AS runtimeId,updated_tick AS updatedTick,updated_at AS updatedAt FROM camera_remote_devices WHERE id=?').get(deviceId) as Device|undefined;
  if (!device || device.runtimeId !== clock.runtimeId || device.updatedTick > clock.tick || device.updatedTick <= clock.tick-10000 || device.updatedAt > clock.wall || device.updatedAt <= clock.wall-10000)
   throw new CameraStopIntentError('offline', 'Kamera ist nicht erreichbar.');
  const slot = db.prepare('SELECT recording_id AS recordingId,intent_id AS intentId,observed_at AS observedAt FROM camera_stop_intents WHERE device_id=?').get(deviceId) as Slot|undefined;
  if (!slot) throw new CameraStopIntentError('conflict', 'Kamera hat keinen reservierten Stoppplatz.');
  // Exact retries remain idempotent even if the device has advanced to finalizing.
  if (slot.recordingId === recordingId) return {id:slot.intentId!, created:false, observed:slot.observedAt!==null};
  if (!['preparing','recording'].includes(device.phase) || device.recordingId !== recordingId)
   throw new CameraStopIntentError('conflict', 'Die Kamera bestätigt diese Aufnahme nicht.');
  if (slot.recordingId !== null && slot.observedAt === null)
   throw new CameraStopIntentError('conflict', 'Ein früherer Stopp ist noch nicht bestätigt.');
  const id = cameraStopIntentId(deviceId, recordingId);
  db.prepare('UPDATE camera_stop_intents SET recording_id=?,intent_id=?,observed_at=NULL WHERE device_id=?').run(recordingId,id,deviceId);
  return {id, created:true, observed:false};
 }).immediate();
}

/** Call inside the serialized heartbeat transaction, after storing its snapshot.
 * An ACK or a different recording never clears the intent. Each poll is a new
 * short-lived delivery; Android subtracts the full request round trip. */
export function deliverCameraStopIntent(db:Database.Database, deviceId:string, phase:CameraPhase, recordingId:string|null, observedAt:number) {
 const slot = db.prepare('SELECT recording_id AS recordingId,intent_id AS intentId,observed_at AS observedAt FROM camera_stop_intents WHERE device_id=?').get(deviceId) as Slot|undefined;
 if (!slot || !slot.recordingId || slot.observedAt!==null) return null;
 if (slot.recordingId === recordingId && ['finalizing','ready','partial','error'].includes(phase)) {
  db.prepare('UPDATE camera_stop_intents SET observed_at=? WHERE device_id=? AND observed_at IS NULL').run(observedAt,deviceId);
  return null;
 }
 // An old intent is never delivered to a different take; retain it for recovery.
 if (slot.recordingId !== recordingId || !['preparing','recording'].includes(phase)) return null;
 return {id:slot.intentId!, type:'record_stop' as const, recordingId:slot.recordingId, projectId:null, remainingMs:DELIVERY_TTL_MS};
}
