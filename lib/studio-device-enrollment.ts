import {createHmac,createPublicKey,randomBytes,randomUUID} from 'node:crypto';
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
 * Real browser-cookie guard; actual device completion and account provisioning
 * are not implemented, and the only HTTP route remains hard-disabled.
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
