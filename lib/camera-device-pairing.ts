import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {CameraClock} from './camera-remote-store.ts';
import {CameraRemoteError} from './camera-remote-store.ts';

// Test-only protocol. Challenges and tickets are invalid across process restarts.
export const PAIRING_CHALLENGE_TTL_MS=59990;
export const PAIRING_TICKET_TTL_MS=299990;
const MAX_DEVICES=10000,MAX_CHALLENGES=1000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
const fail=(message='Ungültiger Gerätenachweis.'):never=>{throw new CameraRemoteError('invalid',message);};
type Action='register'|'session';
type Challenge={deviceId:string;action:Action};
type Complete=Challenge & {challengeId:string;payload:string;signature:string};
type ClockSource=()=>CameraClock;
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value:Record<string,unknown>,expected:string[]){return Object.keys(value).sort().join(',')===expected.slice().sort().join(',');}
function validClock(clock:CameraClock){if(!uuid.test(clock.runtimeId)||!Number.isSafeInteger(clock.wall)||clock.wall<0||!Number.isSafeInteger(clock.tick)||clock.tick<0||clock.wall>Number.MAX_SAFE_INTEGER-PAIRING_TICKET_TTL_MS||clock.tick>Number.MAX_SAFE_INTEGER-PAIRING_TICKET_TTL_MS)fail('Serverzeit nicht verfügbar.');}
function validOwner(owner:string){if(!hash.test(owner))fail();}
function bytes(input:string,max:number):Buffer{if(!/^[A-Za-z0-9_-]*$/.test(input)||input.length>Math.ceil(max*4/3))return fail();const out=Buffer.from(input,'base64url');if(out.length>max||out.toString('base64url')!==input)return fail();return out;}
export function parsePairingChallenge(input:unknown):Challenge{
 if(!object(input)||!keys(input,['deviceId','action'])||typeof input.deviceId!=='string'||!uuid.test(input.deviceId)||(input.action!=='register'&&input.action!=='session'))return fail();
 return {deviceId:input.deviceId,action:input.action};
}
export function parsePairingComplete(input:unknown):Complete{
 if(!object(input)||!keys(input,['deviceId','action','challengeId','payload','signature'])||typeof input.deviceId!=='string'||!uuid.test(input.deviceId)||(input.action!=='register'&&input.action!=='session')||typeof input.challengeId!=='string'||!uuid.test(input.challengeId)||typeof input.payload!=='string'||typeof input.signature!=='string')return fail();
 bytes(input.payload,256);bytes(input.signature,80);
 return {deviceId:input.deviceId,action:input.action,challengeId:input.challengeId,payload:input.payload,signature:input.signature};
}
export const CAMERA_DEVICE_PAIRING_SCHEMA=`
 CREATE TABLE IF NOT EXISTS camera_paired_keys (device_id TEXT PRIMARY KEY, public_key BLOB NOT NULL UNIQUE, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS camera_pairing_challenges (device_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('register','session')), owner_hash TEXT NOT NULL, runtime_id TEXT NOT NULL, created_wall INTEGER NOT NULL, created_tick INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS camera_device_tickets (device_id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, owner_hash TEXT NOT NULL, runtime_id TEXT NOT NULL, created_wall INTEGER NOT NULL, created_tick INTEGER NOT NULL);
`;
export function ensureCameraPairingSchema(db:Database.Database){db.exec(CAMERA_DEVICE_PAIRING_SCHEMA);}
export function isCameraPaired(db:Database.Database,deviceId:string):boolean{return !!db.prepare('SELECT 1 FROM camera_paired_keys WHERE device_id=?').get(deviceId);}
function isLegacyDevice(db:Database.Database,deviceId:string):boolean{
 return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_remote_devices'").get()&&!!db.prepare('SELECT 1 FROM camera_remote_devices WHERE id=?').get(deviceId);
}
function fresh(row:{runtime_id:string;created_wall:number;created_tick:number},clock:CameraClock,ttl:number){return row.runtime_id===clock.runtimeId&&clock.wall>=row.created_wall&&clock.tick>=row.created_tick&&clock.wall-row.created_wall<ttl&&clock.tick-row.created_tick<ttl;}
/** One active challenge per device. No credential or raw bearer ticket is retained. */
export function issuePairingChallenge(db:Database.Database,input:Challenge,owner:string,clock:CameraClock){
 validClock(clock);validOwner(owner);parsePairingChallenge(input);
 return db.transaction(()=>{
  // Expired and other-runtime challenges are safe to forget: a missing nonce cannot be redeemed.
  db.prepare('DELETE FROM camera_pairing_challenges WHERE runtime_id<>? OR created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?').run(clock.runtimeId,clock.wall,clock.tick,clock.wall-PAIRING_CHALLENGE_TTL_MS,clock.tick-PAIRING_CHALLENGE_TTL_MS);
  const known=!!db.prepare('SELECT 1 FROM camera_paired_keys WHERE device_id=?').get(input.deviceId);
  if((input.action==='register'&&(known||isLegacyDevice(db,input.deviceId)))||(input.action==='session'&&!known))throw new CameraRemoteError('conflict','Geräteregistrierung nicht möglich.');
  const existing=!!db.prepare('SELECT 1 FROM camera_pairing_challenges WHERE device_id=?').get(input.deviceId);
  if(!existing&&(db.prepare('SELECT count(*) AS n FROM camera_pairing_challenges').get() as {n:number}).n>=MAX_CHALLENGES)throw new CameraRemoteError('capacity','Zu viele offene Gerätenachweise.');
  if(input.action==='register'&&(db.prepare('SELECT count(*) AS n FROM camera_paired_keys').get() as {n:number}).n>=MAX_DEVICES)throw new CameraRemoteError('capacity','Gerätegrenze erreicht.');
  const challengeId=randomUUID(),challenge=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO camera_pairing_challenges(device_id,id,nonce,action,owner_hash,runtime_id,created_wall,created_tick) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET id=excluded.id,nonce=excluded.nonce,action=excluded.action,owner_hash=excluded.owner_hash,runtime_id=excluded.runtime_id,created_wall=excluded.created_wall,created_tick=excluded.created_tick').run(input.deviceId,challengeId,challenge,input.action,owner,clock.runtimeId,clock.wall,clock.tick);
  return {challengeId,challenge,expiresInMs:PAIRING_CHALLENGE_TTL_MS};
 }).immediate();
}
function keyFromSpki(spki:Buffer){
 try {const key=createPublicKey({key:spki,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(spki))return fail();return key;}catch{return fail();}
}
export function completePairing(db:Database.Database,input:Complete,owner:string,clockSource:ClockSource){
 parsePairingComplete(input);validOwner(owner);const payload=bytes(input.payload,256),signature=bytes(input.signature,80);
 if(input.action==='session'&&payload.length!==0)fail();
 return db.transaction(()=>{
  const clock=clockSource();validClock(clock);
  const row=db.prepare('SELECT * FROM camera_pairing_challenges WHERE device_id=? AND id=? AND action=? AND owner_hash=?').get(input.deviceId,input.challengeId,input.action,owner) as {nonce:string;runtime_id:string;created_wall:number;created_tick:number}|undefined;
  if(!row||!fresh(row,clock,PAIRING_CHALLENGE_TTL_MS))return fail('Gerätenachweis abgelaufen oder ungültig.');
  const stored=db.prepare('SELECT public_key FROM camera_paired_keys WHERE device_id=?').get(input.deviceId) as {public_key:Buffer}|undefined;
  if((input.action==='register'&&(stored||isLegacyDevice(db,input.deviceId)))||(input.action==='session'&&!stored))throw new CameraRemoteError('conflict','Geräteregistrierung nicht möglich.');
  const spki=input.action==='register'?payload:stored!.public_key,key=keyFromSpki(spki);
  const message=`videomaker-camera-device-auth/v2\n${input.deviceId}\n${input.challengeId}\n${row.nonce}\n${input.action}\n${sha(payload)}\n`;
  if(!verify('sha256',Buffer.from(message,'utf8'),{key,dsaEncoding:'der'},signature))return fail();
  const now=clockSource();validClock(now);if(!fresh(row,now,PAIRING_CHALLENGE_TTL_MS))return fail('Gerätenachweis abgelaufen oder ungültig.');
  // Transaction serializes redemption and key/ticket creation across workers.
  if(db.prepare('DELETE FROM camera_pairing_challenges WHERE device_id=? AND id=?').run(input.deviceId,input.challengeId).changes!==1)return fail();
  if(input.action==='register'){
   if((db.prepare('SELECT count(*) AS n FROM camera_paired_keys').get() as {n:number}).n>=MAX_DEVICES)throw new CameraRemoteError('capacity','Gerätegrenze erreicht.');
   if(db.prepare('SELECT 1 FROM camera_paired_keys WHERE public_key=?').get(spki))throw new CameraRemoteError('conflict','Geräteschlüssel bereits registriert.');
   db.prepare('INSERT INTO camera_paired_keys(device_id,public_key,created_at) VALUES(?,?,?)').run(input.deviceId,spki,now.wall);
   return {registered:true as const};
  }
  const ticket=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO camera_device_tickets(device_id,ticket_hash,owner_hash,runtime_id,created_wall,created_tick) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET ticket_hash=excluded.ticket_hash,owner_hash=excluded.owner_hash,runtime_id=excluded.runtime_id,created_wall=excluded.created_wall,created_tick=excluded.created_tick').run(input.deviceId,sha(ticket),owner,now.runtimeId,now.wall,now.tick);
  return {ticket,expiresInMs:PAIRING_TICKET_TTL_MS};
 }).immediate();
}
/** Caller must separately enforce studio authorization and Origin. */
export function verifyCameraDeviceTicket(db:Database.Database,deviceId:string,ticket:string,owner:string,clock:CameraClock):boolean{
 validClock(clock);validOwner(owner);if(!uuid.test(deviceId)||typeof ticket!=='string')return false;
 try{if(bytes(ticket,32).length!==32)return false;}catch{return false;}
 const row=db.prepare('SELECT runtime_id,created_wall,created_tick FROM camera_device_tickets WHERE device_id=? AND ticket_hash=? AND owner_hash=?').get(deviceId,sha(ticket),owner) as {runtime_id:string;created_wall:number;created_tick:number}|undefined;
 return !!row&&fresh(row,clock,PAIRING_TICKET_TTL_MS);
}
