import {createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {CameraClock, CameraRequest} from './camera-remote-store';

// A building block only; no route currently uses these permits. Each issuer has
// an ephemeral key, so a process restart or another worker cannot accept them.
// Production requires one shared generation and authenticated issuance.
const PERMIT_TTL_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER = /^[0-9a-f]{64}$/;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const DOMAIN = 'videomaker-camera-start-permit/v1\0';

type StartPermit = {
 ownerHash:string; deviceId:string; request:CameraRequest;
 runtimeId:string; issuedWall:number; issuedTick:number; expiresWall:number; expiresTick:number;
};
export class CameraStartPermitError extends Error {
 constructor() {super('Ungültige oder abgelaufene Startberechtigung.');}
}
const invalid=():never=>{throw new CameraStartPermitError();};
function canonicalUuid(value:unknown):string {
 if(typeof value!=='string'||!UUID.test(value.toLowerCase()))return invalid();
 return value.toLowerCase();
}
function checkClock(clock:CameraClock) {
 if(!clock||typeof clock.runtimeId!=='string'||!UUID.test(clock.runtimeId)||
   !Number.isSafeInteger(clock.wall)||clock.wall<0||clock.wall>Number.MAX_SAFE_INTEGER-PERMIT_TTL_MS||
   !Number.isSafeInteger(clock.tick)||clock.tick<0||clock.tick>Number.MAX_SAFE_INTEGER-PERMIT_TTL_MS)invalid();
}
function decodeCanonical(value:string) {
 if(!ENCODED.test(value))return invalid();
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value)return invalid();
 return bytes;
}

/** Issue unpredictable command and recording IDs; never accept these IDs from the caller. */
export class CameraStartPermitIssuer {
 readonly #key=randomBytes(32);
 #runtimeId:string|undefined;
 #highWall=-1;
 #highTick=-1;
 #clockFailed=false;

 // Only a trusted server clock may be passed here. An observed backwards jump
 // permanently disables this generation; otherwise an expired permit could
 // become valid again after a clock rollback.
 #checkClock(clock:CameraClock) {
  if(this.#clockFailed)return invalid();
  try{checkClock(clock);}catch{this.#clockFailed=true;return invalid();}
  if((this.#runtimeId!==undefined&&clock.runtimeId!==this.#runtimeId)||clock.wall<this.#highWall||clock.tick<this.#highTick){
   this.#clockFailed=true;return invalid();
  }
  this.#runtimeId=clock.runtimeId;this.#highWall=clock.wall;this.#highTick=clock.tick;
 }

 issue(ownerHash:string,deviceId:string,projectId:string,clock:CameraClock) {
  this.#checkClock(clock);
  if(typeof ownerHash!=='string'||!OWNER.test(ownerHash))return invalid();
  deviceId=canonicalUuid(deviceId);projectId=canonicalUuid(projectId);
  const payload=[1,ownerHash,deviceId,projectId,randomUUID(),randomUUID(),clock.runtimeId,
   clock.wall,clock.tick,clock.wall+PERMIT_TTL_MS,clock.tick+PERMIT_TTL_MS];
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac=createHmac('sha256',this.#key).update(DOMAIN).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
 }

 /** Check the authenticated owner and both clocks, and derive the request from signed bytes. */
 verify(token:unknown,ownerHash:string,clock:CameraClock):StartPermit {
  this.#checkClock(clock);
  if(typeof token!=='string'||token.length>2048||typeof ownerHash!=='string'||!OWNER.test(ownerHash))return invalid();
  const parts=token.split('.');if(parts.length!==2)return invalid();
  const signature=decodeCanonical(parts[1]);
  const expected=createHmac('sha256',this.#key).update(DOMAIN).update(parts[0]).digest();
  if(signature.length!==expected.length||!timingSafeEqual(signature,expected))return invalid();
  let payload:unknown;
  try{payload=JSON.parse(decodeCanonical(parts[0]).toString('utf8'));}catch{return invalid();}
  if(!Array.isArray(payload)||payload.length!==11)return invalid();
  const [version,owner,deviceId,projectId,recordingId,commandId,runtimeId,issuedWall,issuedTick,expiresWall,expiresTick]=payload;
  if(version!==1||owner!==ownerHash||typeof deviceId!=='string'||!UUID.test(deviceId)||
   typeof projectId!=='string'||!UUID.test(projectId)||typeof recordingId!=='string'||!UUID.test(recordingId)||
   typeof commandId!=='string'||!UUID.test(commandId)||typeof runtimeId!=='string'||runtimeId!==clock.runtimeId||
   !Number.isSafeInteger(issuedWall)||!Number.isSafeInteger(issuedTick)||!Number.isSafeInteger(expiresWall)||!Number.isSafeInteger(expiresTick)||
   issuedWall<0||issuedTick<0||expiresWall!==issuedWall+PERMIT_TTL_MS||expiresTick!==issuedTick+PERMIT_TTL_MS||
   clock.wall<issuedWall||clock.tick<issuedTick||clock.wall>=expiresWall||clock.tick>=expiresTick)return invalid();
  return {ownerHash:owner,deviceId,request:{id:commandId,type:'record_start',recordingId,projectId},
   runtimeId,issuedWall,issuedTick,expiresWall,expiresTick};
 }
}
