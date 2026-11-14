import type Database from 'better-sqlite3';
import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';

type Clock={runtimeId:string;wall:number;tick:number};
type Side={deviceId:string;publicKey:Buffer;signature:Buffer};
type Completion={pairId:string;challengeId:string;camera:Side;prompter:Side;transcriptHash:string};
export class RelayPairingError extends Error {constructor(readonlyCode:string){super(readonlyCode);}}
const fail=(code:string):never=>{throw new RelayPairingError(code);};
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const TTL=59_990,MAX_PENDING=32,MAX_DEVICES=1000,MAX_PAIRS=1000;
function checkClock(clock:Clock){if(!uuid(clock.runtimeId)||!Number.isSafeInteger(clock.wall)||clock.wall<0||!Number.isSafeInteger(clock.tick)||clock.tick<0)fail('INVALID');}
function fresh(row:{runtime_id:string;created_wall:number;created_tick:number},clock:Clock){return row.runtime_id===clock.runtimeId&&clock.wall>=row.created_wall&&clock.tick>=row.created_tick&&clock.wall-row.created_wall<TTL&&clock.tick-row.created_tick<TTL;}
function publicKey(value:Buffer){
 if(!Buffer.isBuffer(value)||value.length>256)fail('INVALID');
 try{const key=createPublicKey({key:value,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(value))return fail('INVALID');return key;}catch{return fail('INVALID');}
}
export const RELAY_PAIRING_SCHEMA=`
 CREATE TABLE IF NOT EXISTS relay_pair_devices(device_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,public_key BLOB NOT NULL UNIQUE,created_at INTEGER NOT NULL,revoked_at INTEGER);
 CREATE TABLE IF NOT EXISTS relay_pair_links(pair_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,camera_id TEXT NOT NULL,prompter_id TEXT NOT NULL,transcript_hash TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
 CREATE TABLE IF NOT EXISTS relay_pair_challenges(pair_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE,owner_hash TEXT NOT NULL,transcript_hash TEXT NOT NULL,nonce TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_pair_completions(pair_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL,proof_hash TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS relay_pair_completions_no_delete BEFORE DELETE ON relay_pair_completions BEGIN SELECT RAISE(ABORT,'relay pairing proof cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_completions_no_update BEFORE UPDATE ON relay_pair_completions BEGIN SELECT RAISE(ABORT,'relay pairing proof cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_completions_insert_guard BEFORE INSERT ON relay_pair_completions BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM relay_pair_completions p WHERE p.pair_id=NEW.pair_id OR p.rowid=NEW.rowid) THEN RAISE(ABORT,'relay pairing proof already exists') END; END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_devices_no_delete BEFORE DELETE ON relay_pair_devices BEGIN SELECT RAISE(ABORT,'relay identities cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_devices_guard BEFORE UPDATE ON relay_pair_devices BEGIN SELECT CASE WHEN NEW.device_id IS NOT OLD.device_id OR NEW.owner_hash IS NOT OLD.owner_hash OR NEW.public_key IS NOT OLD.public_key OR NEW.created_at IS NOT OLD.created_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE(ABORT,'relay identity is immutable') END; END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_devices_insert_guard BEFORE INSERT ON relay_pair_devices BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM relay_pair_devices d WHERE d.device_id=NEW.device_id OR d.public_key=NEW.public_key OR d.rowid=NEW.rowid) THEN RAISE(ABORT,'relay identity already exists') END; END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_links_no_delete BEFORE DELETE ON relay_pair_links BEGIN SELECT RAISE(ABORT,'relay pairings cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_links_guard BEFORE UPDATE ON relay_pair_links BEGIN SELECT CASE WHEN NEW.pair_id IS NOT OLD.pair_id OR NEW.owner_hash IS NOT OLD.owner_hash OR NEW.camera_id IS NOT OLD.camera_id OR NEW.prompter_id IS NOT OLD.prompter_id OR NEW.transcript_hash IS NOT OLD.transcript_hash OR NEW.created_at IS NOT OLD.created_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE(ABORT,'relay pairing is immutable') END; END;
 CREATE TRIGGER IF NOT EXISTS relay_pair_links_insert_guard BEFORE INSERT ON relay_pair_links BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM relay_pair_links p WHERE p.pair_id=NEW.pair_id OR p.rowid=NEW.rowid) THEN RAISE(ABORT,'relay pairing already exists') END; END;
`;
/** Called only inside the authenticated caller's immediate transaction. */
function requireAuthorization(db:Database.Database,owner:string,authorize:()=>boolean){if(!db.inTransaction||!hash(owner))fail('INVALID');if(authorize()!==true)fail('UNAUTHORIZED');}
export function beginRelayPairing(db:Database.Database,owner:string,pairId:string,transcriptHash:string,clockSource:()=>Clock,authorize:()=>boolean){
 if(!uuid(pairId)||!hash(transcriptHash))return fail('INVALID');
 return db.transaction(()=>{
  requireAuthorization(db,owner,authorize);let clock=clockSource();checkClock(clock);db.exec(RELAY_PAIRING_SCHEMA);
  const existing=db.prepare('SELECT owner_hash,transcript_hash,revoked_at FROM relay_pair_links WHERE pair_id=?').get(pairId) as {owner_hash:string;transcript_hash:string;revoked_at:number|null}|undefined;
  if(existing){if(existing.owner_hash!==owner||existing.transcript_hash!==transcriptHash||existing.revoked_at!==null)fail('CONFLICT');requireAuthorization(db,owner,authorize);return {paired:true as const};}
  const old=db.prepare('SELECT * FROM relay_pair_challenges WHERE pair_id=?').get(pairId) as {owner_hash:string;transcript_hash:string;challenge_id:string;nonce:string;runtime_id:string;created_wall:number;created_tick:number}|undefined;
  if(old&&old.owner_hash!==owner||old&&old.transcript_hash!==transcriptHash)fail('CONFLICT');
  if(old&&fresh(old,clock)){requireAuthorization(db,owner,authorize);clock=clockSource();checkClock(clock);if(fresh(old,clock))return {paired:false as const,challengeId:old.challenge_id,nonce:old.nonce};}
  if(old)db.prepare('DELETE FROM relay_pair_challenges WHERE pair_id=?').run(pairId);
  db.prepare('DELETE FROM relay_pair_challenges WHERE runtime_id=? AND (created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(clock.runtimeId,clock.wall,clock.tick,clock.wall-TTL,clock.tick-TTL);
  if((db.prepare('SELECT count(*) AS n FROM relay_pair_challenges').get() as {n:number}).n>=MAX_PENDING||(db.prepare('SELECT count(*) AS n FROM relay_pair_challenges WHERE owner_hash=?').get(owner) as {n:number}).n>=4)fail('CAPACITY');
  const challengeId=randomUUID(),nonce=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO relay_pair_challenges VALUES(?,?,?,?,?,?,?,?)').run(pairId,challengeId,owner,transcriptHash,nonce,clock.runtimeId,clock.wall,clock.tick);
  requireAuthorization(db,owner,authorize);const final=clockSource();checkClock(final);if(!fresh({runtime_id:clock.runtimeId,created_wall:clock.wall,created_tick:clock.tick},final))return fail('EXPIRED');
  return {paired:false as const,challengeId,nonce};
 }).immediate();
}
/** Both phones sign exactly these domain-separated bytes after validating their E2E transcript. */
export function relayPairingMessage(owner:string,pairId:string,challengeId:string,nonce:string,transcriptHash:string,cameraId:string,cameraKey:Buffer,prompterId:string,prompterKey:Buffer,role:'camera'|'prompter'){
 return Buffer.from(`videomaker-relay-pair/v1\n${owner}\n${pairId}\n${challengeId}\n${nonce}\n${transcriptHash}\n${cameraId}\n${sha(cameraKey)}\n${prompterId}\n${sha(prompterKey)}\n${role}\n`,'utf8');
}
export function completeRelayPairing(db:Database.Database,owner:string,input:Completion,clock:()=>Clock,authorize:()=>boolean){
 if(!uuid(input.pairId)||!uuid(input.challengeId)||!hash(input.transcriptHash)||!uuid(input.camera.deviceId)||!uuid(input.prompter.deviceId)||input.camera.deviceId===input.prompter.deviceId||!Buffer.isBuffer(input.camera.signature)||input.camera.signature.length>80||!Buffer.isBuffer(input.prompter.signature)||input.prompter.signature.length>80)fail('INVALID');
 const camKey=publicKey(input.camera.publicKey),proKey=publicKey(input.prompter.publicKey);if(input.camera.publicKey.equals(input.prompter.publicKey))fail('INVALID');
 const proofHash=sha(Buffer.from(JSON.stringify([owner,input.pairId,input.challengeId,input.transcriptHash,input.camera.deviceId,input.camera.publicKey.toString('base64'),input.camera.signature.toString('base64'),input.prompter.deviceId,input.prompter.publicKey.toString('base64'),input.prompter.signature.toString('base64')]),'utf8'));
 return db.transaction(()=>{
  requireAuthorization(db,owner,authorize);db.exec(RELAY_PAIRING_SCHEMA);
  const existing=db.prepare('SELECT * FROM relay_pair_links WHERE pair_id=?').get(input.pairId) as {owner_hash:string;camera_id:string;prompter_id:string;transcript_hash:string;revoked_at:number|null}|undefined;
  if(existing){
   const proof=db.prepare('SELECT challenge_id,proof_hash FROM relay_pair_completions WHERE pair_id=?').get(input.pairId) as {challenge_id:string;proof_hash:string}|undefined;
   if(!proof||proof.challenge_id!==input.challengeId||proof.proof_hash!==proofHash)fail('PROOF');
   const devices=db.prepare('SELECT device_id,owner_hash,public_key,revoked_at FROM relay_pair_devices WHERE device_id IN (?,?)').all(input.camera.deviceId,input.prompter.deviceId) as {device_id:string;owner_hash:string;public_key:Buffer;revoked_at:number|null}[];
   if(existing.owner_hash!==owner||existing.camera_id!==input.camera.deviceId||existing.prompter_id!==input.prompter.deviceId||existing.transcript_hash!==input.transcriptHash||existing.revoked_at!==null||devices.length!==2||devices.some(d=>d.owner_hash!==owner||d.revoked_at!==null||!d.public_key.equals(d.device_id===input.camera.deviceId?input.camera.publicKey:input.prompter.publicKey)))fail('CONFLICT');
   requireAuthorization(db,owner,authorize);return {pairId:input.pairId,created:false};
  }
  const row=db.prepare('SELECT * FROM relay_pair_challenges WHERE pair_id=? AND challenge_id=? AND owner_hash=? AND transcript_hash=?').get(input.pairId,input.challengeId,owner,input.transcriptHash) as {nonce:string;runtime_id:string;created_wall:number;created_tick:number}|undefined;
  let now=clock();checkClock(now);if(!row||!fresh(row,now))return fail('EXPIRED');
  for(const [role,side,key] of [['camera',input.camera,camKey],['prompter',input.prompter,proKey]] as const){
   const msg=relayPairingMessage(owner,input.pairId,input.challengeId,row.nonce,input.transcriptHash,input.camera.deviceId,input.camera.publicKey,input.prompter.deviceId,input.prompter.publicKey,role);
   let valid=false;try{valid=verify('sha256',msg,{key,dsaEncoding:'der'},side.signature);}catch{/* malformed signature fails closed */}
   if(!valid)fail('PROOF');
  }
  now=clock();checkClock(now);requireAuthorization(db,owner,authorize);if(!fresh(row,now))return fail('EXPIRED');
  if((db.prepare('SELECT count(*) AS n FROM relay_pair_links').get() as {n:number}).n>=MAX_PAIRS)fail('CAPACITY');
  for(const side of [input.camera,input.prompter]){
   const found=db.prepare('SELECT owner_hash,public_key,revoked_at FROM relay_pair_devices WHERE device_id=?').get(side.deviceId) as {owner_hash:string;public_key:Buffer;revoked_at:number|null}|undefined;
   if(found){if(found.owner_hash!==owner||found.revoked_at!==null||!found.public_key.equals(side.publicKey))fail('CONFLICT');}
   else{if((db.prepare('SELECT count(*) AS n FROM relay_pair_devices').get() as {n:number}).n>=MAX_DEVICES)fail('CAPACITY');db.prepare('INSERT INTO relay_pair_devices(device_id,owner_hash,public_key,created_at) VALUES(?,?,?,?)').run(side.deviceId,owner,side.publicKey,now.wall);}
  }
  db.prepare('INSERT INTO relay_pair_links(pair_id,owner_hash,camera_id,prompter_id,transcript_hash,created_at) VALUES(?,?,?,?,?,?)').run(input.pairId,owner,input.camera.deviceId,input.prompter.deviceId,input.transcriptHash,now.wall);
  db.prepare('INSERT INTO relay_pair_completions(pair_id,challenge_id,proof_hash) VALUES(?,?,?)').run(input.pairId,input.challengeId,proofHash);
  db.prepare('DELETE FROM relay_pair_challenges WHERE pair_id=?').run(input.pairId);
  requireAuthorization(db,owner,authorize);const final=clock();checkClock(final);if(!fresh(row,final))return fail('EXPIRED');
  return {pairId:input.pairId,created:true};
 }).immediate();
}
export function revokeRelayPairing(db:Database.Database,owner:string,pairId:string,now:number,authorize:()=>boolean){
 if(!uuid(pairId)||!Number.isSafeInteger(now)||now<0)fail('INVALID');
 return db.transaction(()=>{requireAuthorization(db,owner,authorize);const row=db.prepare('SELECT owner_hash,revoked_at FROM relay_pair_links WHERE pair_id=?').get(pairId) as {owner_hash:string;revoked_at:number|null}|undefined;if(!row||row.owner_hash!==owner)fail('MISSING');if(row.revoked_at!==null)return false;db.prepare('UPDATE relay_pair_links SET revoked_at=? WHERE pair_id=? AND revoked_at IS NULL').run(now,pairId);return true;}).immediate();
}
export function revokeRelayDevice(db:Database.Database,owner:string,deviceId:string,now:number,authorize:()=>boolean){
 if(!uuid(deviceId)||!Number.isSafeInteger(now)||now<0)fail('INVALID');
 return db.transaction(()=>{requireAuthorization(db,owner,authorize);const row=db.prepare('SELECT owner_hash,revoked_at FROM relay_pair_devices WHERE device_id=?').get(deviceId) as {owner_hash:string;revoked_at:number|null}|undefined;if(!row||row.owner_hash!==owner)fail('MISSING');if(row.revoked_at!==null)return false;db.prepare('UPDATE relay_pair_devices SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(now,deviceId);db.prepare('UPDATE relay_pair_links SET revoked_at=? WHERE owner_hash=? AND revoked_at IS NULL AND (camera_id=? OR prompter_id=?)').run(now,owner,deviceId,deviceId);return true;}).immediate();
}
