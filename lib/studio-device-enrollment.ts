import {createHash,createHmac,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import type Database from 'better-sqlite3';
import {sessionAuthorized,sessionSignatureValidIgnoringExpiry} from './auth';

/** WIP only: caller must enforce the disabled route gate and same-origin. */
const challengeMs=60_000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const clockSchema=`CREATE TABLE IF NOT EXISTS studio_device_enrollment_clock(id INTEGER PRIMARY KEY CHECK(id=1),floor_ms INTEGER NOT NULL);
 INSERT OR IGNORE INTO studio_device_enrollment_clock(id,floor_ms) VALUES(1,0);`;
const schema=`CREATE TABLE IF NOT EXISTS studio_device_enrollment_challenges(device_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE,nonce TEXT NOT NULL,public_key BLOB NOT NULL,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,session_hash TEXT NOT NULL,created_ms INTEGER NOT NULL);`;
type Authority={owner_hash:string;workspace_hash:string};
type Clock={floor_ms:number};
type Count={n:number};
export type StudioEnrollmentInput={deviceId:string;publicKey:Buffer};

function validKey(bytes:Buffer):boolean{
 try{
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>256)return false;
  const key=createPublicKey({key:bytes,format:'der',type:'spki'});
  return key.asymmetricKeyType==='ec'&&key.asymmetricKeyDetails?.namedCurve==='prime256v1'&&Buffer.from(key.export({format:'der',type:'spki'})).equals(bytes);
 }catch{return false;}
}
/**
 * Real browser-cookie guard; account provisioning is not implemented and
 * both enrollment HTTP routes remain hard-disabled.
 * No caller-supplied authority or callback is used inside this transaction.
 */
export function beginStudioDeviceEnrollment(database:Database.Database,credential:string,input:StudioEnrollmentInput){
 if(database.inTransaction)throw Error('outer transaction forbidden');
 if(typeof credential!=='string'||!input||!uuid.test(input.deviceId)||!validKey(input.publicKey))return null;
 const expiryText=credential.split('.')[0];if(!/^[1-9][0-9]{0,15}$/.test(expiryText))return null;
 const credentialExpiry=Number(expiryText);if(!Number.isSafeInteger(credentialExpiry))return null;
 const secret=process.env.SESSION_SECRET;if(!secret||secret.length<32)return null;
 const sessionHash=createHmac('sha256',secret).update('studio-device-browser-session/v2\0').update(credential).digest('hex');
 return database.transaction(()=>{
  // An expired but genuinely signed cookie must advance the durable clock
  // floor before rejection, otherwise a backward wall-clock jump could revive it.
  if(!sessionSignatureValidIgnoringExpiry(credential))return null;
  database.exec(clockSchema);
  const observe=()=>{const now=Date.now();const row=database.prepare('SELECT floor_ms FROM studio_device_enrollment_clock WHERE id=1').get() as Clock|undefined;
   if(!Number.isSafeInteger(now)||!row||!Number.isSafeInteger(row.floor_ms)||now<row.floor_ms)return null;
   database.prepare('UPDATE studio_device_enrollment_clock SET floor_ms=? WHERE id=1').run(now);return now;};
  const first=observe();if(first===null)return null;
  const authorized=sessionAuthorized(database,credential);const now=observe();if(!authorized||now===null||now>=credentialExpiry)return null;
  // Provisioning a stable real account/workspace is a separate future task.
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_device_authority'").get())return null;
  const owners=database.prepare('SELECT owner_hash,workspace_hash FROM studio_device_authority LIMIT 2').all() as Authority[];
  if(owners.length!==1||!hash.test(owners[0].owner_hash)||!hash.test(owners[0].workspace_hash))return null;
  const authority=owners[0];database.exec(schema);
  database.prepare('DELETE FROM studio_device_enrollment_challenges WHERE created_ms<=?').run(now-challengeMs);
  if((database.prepare('SELECT COUNT(*) n FROM studio_device_enrollment_challenges').get() as Count).n>=200||database.prepare('SELECT 1 FROM studio_device_enrollment_challenges WHERE device_id=?').get(input.deviceId))return null;
  const challengeId=randomUUID(),nonce=randomBytes(32).toString('base64url');
  database.exec('SAVEPOINT studio_enrollment_begin');
  database.prepare('INSERT INTO studio_device_enrollment_challenges VALUES(?,?,?,?,?,?,?,?)').run(input.deviceId,challengeId,nonce,input.publicKey,authority.owner_hash,authority.workspace_hash,sessionHash,now);
  const final=observe();const stillAuthorized=final!==null&&sessionAuthorized(database,credential);const last=observe();
  const latest=database.prepare('SELECT owner_hash,workspace_hash FROM studio_device_authority LIMIT 2').all() as Authority[];
  if(final===null||last===null||last>=credentialExpiry||last-now>=challengeMs||!stillAuthorized||latest.length!==1||latest[0].owner_hash!==authority.owner_hash||latest[0].workspace_hash!==authority.workspace_hash){
   database.exec('ROLLBACK TO studio_enrollment_begin; RELEASE studio_enrollment_begin');
   const retained=last??final;if(retained!==null)database.prepare('UPDATE studio_device_enrollment_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(retained);
   return null;
  }
  database.exec('RELEASE studio_enrollment_begin');
  return {challengeId,nonce,ownerHash:authority.owner_hash,workspaceHash:authority.workspace_hash,confirmingSessionHash:sessionHash,scope:['projects:read','recordings:upload'],expiresInMs:challengeMs-(last-now)};
 }).immediate();
}


type ChallengeRow={device_id:string;challenge_id:string;nonce:string;public_key:Buffer;owner_hash:string;workspace_hash:string;session_hash:string;created_ms:number};
type DeviceRow=ChallengeRow & {proof_hash:string;revoked:number};
const deviceSchema=`CREATE TABLE IF NOT EXISTS studio_device_keys(device_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE,nonce TEXT NOT NULL,public_key BLOB NOT NULL UNIQUE,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,session_hash TEXT NOT NULL,created_ms INTEGER NOT NULL,proof_hash TEXT NOT NULL,revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
 CREATE TRIGGER IF NOT EXISTS studio_device_keys_no_replace BEFORE INSERT ON studio_device_keys WHEN EXISTS(SELECT 1 FROM studio_device_keys WHERE device_id=NEW.device_id OR challenge_id=NEW.challenge_id OR public_key=NEW.public_key) BEGIN SELECT RAISE(ABORT,'device identity already exists'); END;
 CREATE TRIGGER IF NOT EXISTS studio_device_keys_no_delete BEFORE DELETE ON studio_device_keys BEGIN SELECT RAISE(ABORT,'device identity must be retained'); END;
 CREATE TRIGGER IF NOT EXISTS studio_device_keys_no_rewrite BEFORE UPDATE ON studio_device_keys WHEN OLD.device_id IS NOT NEW.device_id OR OLD.challenge_id IS NOT NEW.challenge_id OR OLD.nonce IS NOT NEW.nonce OR OLD.public_key IS NOT NEW.public_key OR OLD.owner_hash IS NOT NEW.owner_hash OR OLD.workspace_hash IS NOT NEW.workspace_hash OR OLD.session_hash IS NOT NEW.session_hash OR OLD.created_ms IS NOT NEW.created_ms OR OLD.proof_hash IS NOT NEW.proof_hash OR OLD.revoked>NEW.revoked BEGIN SELECT RAISE(ABORT,'device identity is immutable'); END;`;
const bytesHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function enrollmentMessage(row:ChallengeRow){
 return Buffer.from(`videomaker-studio-device-auth/enroll/v2\n${row.device_id}\n${row.challenge_id}\n${row.nonce}\n${bytesHash(Buffer.from(row.public_key))}\nprojects:read,recordings:upload\n${row.owner_hash}\n${row.workspace_hash}\n${row.session_hash}\n`,'utf8');
}
function verifyProof(row:ChallengeRow,proof:Buffer):boolean{
 try{return validKey(Buffer.from(row.public_key))&&verify('sha256',enrollmentMessage(row),{key:createPublicKey({key:Buffer.from(row.public_key),format:'der',type:'spki'}),dsaEncoding:'der'},proof);}catch{return false;}
}
/** Exact-proof retries acknowledge a previously registered key; they never mint a ticket. */
export function completeStudioDeviceEnrollment(database:Database.Database,credential:string,input:{deviceId:string;challengeId:string;signature:Buffer}){
 if(database.inTransaction)throw Error('outer transaction forbidden');
 if(typeof credential!=='string'||!input||!uuid.test(input.deviceId)||!uuid.test(input.challengeId)||!Buffer.isBuffer(input.signature)||input.signature.length<1||input.signature.length>80)return null;
 const expiryText=credential.split('.')[0];if(!/^[1-9][0-9]{0,15}$/.test(expiryText))return null;
 const credentialExpiry=Number(expiryText),secret=process.env.SESSION_SECRET;if(!Number.isSafeInteger(credentialExpiry)||!secret||secret.length<32)return null;
 const sessionHash=createHmac('sha256',secret).update('studio-device-browser-session/v2\0').update(credential).digest('hex');
 return database.transaction(()=>{
  if(!sessionSignatureValidIgnoringExpiry(credential))return null;
  database.exec(clockSchema);
  const observe=()=>{const now=Date.now();const row=database.prepare('SELECT floor_ms FROM studio_device_enrollment_clock WHERE id=1').get() as Clock|undefined;
   if(!Number.isSafeInteger(now)||!row||!Number.isSafeInteger(row.floor_ms)||now<row.floor_ms)return null;
   database.prepare('UPDATE studio_device_enrollment_clock SET floor_ms=? WHERE id=1').run(now);return now;};
  const first=observe();if(first===null)return null;
  const authorized=sessionAuthorized(database,credential),now=observe();if(!authorized||now===null||now>=credentialExpiry)return null;
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_device_authority'").get()||!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_device_enrollment_challenges'").get())return null;
  const authorities=database.prepare('SELECT owner_hash,workspace_hash FROM studio_device_authority LIMIT 2').all() as Authority[];
  if(authorities.length!==1||!hash.test(authorities[0].owner_hash)||!hash.test(authorities[0].workspace_hash))return null;
  const authority=authorities[0];database.exec(deviceSchema);
  const existing=database.prepare('SELECT * FROM studio_device_keys WHERE device_id=?').get(input.deviceId) as DeviceRow|undefined;
  if(existing){
   if(existing.revoked||existing.challenge_id!==input.challengeId||existing.session_hash!==sessionHash||existing.owner_hash!==authority.owner_hash||existing.workspace_hash!==authority.workspace_hash||existing.proof_hash!==bytesHash(input.signature)||!verifyProof(existing,input.signature))return null;
   const pre=observe(),valid=pre!==null&&sessionAuthorized(database,credential),last=observe();
   const current=database.prepare('SELECT * FROM studio_device_keys WHERE device_id=?').get(input.deviceId) as DeviceRow|undefined;
   const latest=database.prepare('SELECT owner_hash,workspace_hash FROM studio_device_authority LIMIT 2').all() as Authority[];
   if(!valid||last===null||last>=credentialExpiry||latest.length!==1||latest[0].owner_hash!==authority.owner_hash||latest[0].workspace_hash!==authority.workspace_hash||!current||current.revoked||current.challenge_id!==existing.challenge_id||current.nonce!==existing.nonce||current.created_ms!==existing.created_ms||current.proof_hash!==existing.proof_hash||current.session_hash!==sessionHash||current.owner_hash!==authority.owner_hash||current.workspace_hash!==authority.workspace_hash||!Buffer.from(current.public_key).equals(Buffer.from(existing.public_key)))return null;
   return {enrolled:true,created:false};
  }
  const row=database.prepare('SELECT * FROM studio_device_enrollment_challenges WHERE device_id=? AND challenge_id=?').get(input.deviceId,input.challengeId) as ChallengeRow|undefined;
  if(!row||row.session_hash!==sessionHash||row.owner_hash!==authority.owner_hash||row.workspace_hash!==authority.workspace_hash||!Number.isSafeInteger(row.created_ms)||now<row.created_ms||now-row.created_ms>=challengeMs||!verifyProof(row,input.signature))return null;
  if(database.prepare('SELECT 1 FROM studio_device_keys WHERE public_key=?').get(row.public_key)||(database.prepare('SELECT COUNT(*) n FROM studio_device_keys').get() as Count).n>=100)return null;
  database.exec('SAVEPOINT studio_enrollment_complete');
  database.prepare('INSERT INTO studio_device_keys VALUES(?,?,?,?,?,?,?,?,?,0)').run(row.device_id,row.challenge_id,row.nonce,row.public_key,row.owner_hash,row.workspace_hash,row.session_hash,row.created_ms,bytesHash(input.signature));
  if(database.prepare('DELETE FROM studio_device_enrollment_challenges WHERE device_id=? AND challenge_id=?').run(row.device_id,row.challenge_id).changes!==1)throw Error('Enrollment challenge changed');
  const pre=observe(),valid=pre!==null&&sessionAuthorized(database,credential),last=observe();
  const current=database.prepare('SELECT * FROM studio_device_keys WHERE device_id=?').get(input.deviceId) as DeviceRow|undefined;
  const latest=database.prepare('SELECT owner_hash,workspace_hash FROM studio_device_authority LIMIT 2').all() as Authority[];
  if(!valid||last===null||last>=credentialExpiry||last<row.created_ms||last-row.created_ms>=challengeMs||latest.length!==1||latest[0].owner_hash!==authority.owner_hash||latest[0].workspace_hash!==authority.workspace_hash||!current||current.revoked||current.proof_hash!==bytesHash(input.signature)||current.session_hash!==sessionHash||!Buffer.from(current.public_key).equals(Buffer.from(row.public_key))){
   database.exec('ROLLBACK TO studio_enrollment_complete; RELEASE studio_enrollment_complete');
   const retained=last??pre;if(retained!==null)database.prepare('UPDATE studio_device_enrollment_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(retained);
   return null;
  }
  database.exec('RELEASE studio_enrollment_complete');return {enrolled:true,created:true};
 }).immediate();
}
