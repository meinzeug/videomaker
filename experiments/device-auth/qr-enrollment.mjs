import {createHash,createPublicKey,randomBytes} from 'node:crypto';
import {completeRelayPairing} from '../../lib/relay-pairing-registry.ts';

// Internal fixture only. QR payloads are bearer secrets; never log or put them in a URL query.
const ORIGIN='https://videomaker.dorfspy.de',TTL=59_000,MAX_TOTAL=256,MAX_OWNER=8;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const sha=x=>createHash('sha256').update(x).digest('hex');
const deny=()=>{throw Error('ENROLLMENT_DENIED');};
function requireFixture(db){
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE!=='1')throw Error('DEVICE_AUTH_FIXTURE_DISABLED');
 if(!db||typeof db.transaction!=='function'||db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('INVALID_DB');
}
function checkedClock(source){const c=source();if(!c||!UUID.test(c.runtimeId)||!Number.isSafeInteger(c.wall)||!Number.isSafeInteger(c.tick)||c.wall<0||c.tick<0)deny();return c;}
function fresh(row,c){return row.runtime_id===c.runtimeId&&c.wall>=row.created_wall&&c.tick>=row.created_tick&&c.wall-row.created_wall<TTL&&c.tick-row.created_tick<TTL;}
function keyHash(key){
 if(!Buffer.isBuffer(key)||key.length>256)deny();
 try{const parsed=createPublicKey({key,format:'der',type:'spki'});if(parsed.asymmetricKeyType!=='ec'||parsed.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(parsed.export({format:'der',type:'spki'})).equals(key))deny();return sha(key);}catch{deny();}
}
function tokenHash(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const raw=Buffer.from(token,'base64url');return raw.length===32&&raw.toString('base64url')===token?sha(raw):null;}
function binding(input){
 if(!input||!UUID.test(input.pairId)||!UUID.test(input.challengeId)||!HASH.test(input.transcriptHash)||!UUID.test(input.camera?.deviceId)||!UUID.test(input.prompter?.deviceId)||input.camera.deviceId===input.prompter.deviceId)deny();
 const cameraHash=keyHash(input.camera.publicKey),prompterHash=keyHash(input.prompter.publicKey);if(cameraHash===prompterHash)deny();
 return {pairId:input.pairId,challengeId:input.challengeId,transcriptHash:input.transcriptHash,cameraId:input.camera.deviceId,prompterId:input.prompter.deviceId,cameraHash,prompterHash};
}
function same(row,owner,session,b,consumed=false){return row&&row.owner_hash===owner&&row.session_hash===session&&row.pair_id===b.pairId&&row.challenge_id===b.challengeId&&row.transcript_hash===b.transcriptHash&&row.camera_id===b.cameraId&&row.prompter_id===b.prompterId&&row.camera_key_hash===b.cameraHash&&row.prompter_key_hash===b.prompterHash&&(consumed?Number.isSafeInteger(row.consumed_at):row.consumed_at===null);}
function auth(authorize,owner,session,b){if(typeof authorize!=='function'||authorize(owner,session,Object.freeze({...b}))!==true)deny();}

export function initializeQrEnrollmentFixture(db){
 requireFixture(db);db.transaction(()=>{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_pair_challenges'").get())throw Error('MISSING_PAIR_REGISTRY');
  db.exec(`CREATE TABLE IF NOT EXISTS device_enrollment_tickets(token_hash TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,session_hash TEXT NOT NULL,pair_id TEXT NOT NULL,challenge_id TEXT NOT NULL,transcript_hash TEXT NOT NULL,camera_id TEXT NOT NULL,prompter_id TEXT NOT NULL,camera_key_hash TEXT NOT NULL,prompter_key_hash TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,consumed_at INTEGER);`);
 }).immediate();
}

/** The trusted admin UI has independently presented and confirmed these exact two key fingerprints. */
export function issueQrEnrollmentFixture(db,{ownerHash,sessionHash,input},clock,authorize){
 requireFixture(db);if(!HASH.test(ownerHash)||!HASH.test(sessionHash)||typeof clock!=='function')deny();const b=binding(input);
 return db.transaction(()=>{
  auth(authorize,ownerHash,sessionHash,b);const now=checkedClock(clock);
  if(now.wall>Number.MAX_SAFE_INTEGER-TTL)deny();
  const challenge=db.prepare('SELECT * FROM relay_pair_challenges WHERE pair_id=? AND challenge_id=? AND owner_hash=? AND transcript_hash=?').get(b.pairId,b.challengeId,ownerHash,b.transcriptHash);
  if(!challenge||!fresh(challenge,now)||db.prepare('SELECT 1 FROM relay_pair_links WHERE pair_id=?').get(b.pairId))deny();
  db.prepare('DELETE FROM device_enrollment_tickets WHERE runtime_id=? AND (created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(now.runtimeId,now.wall,now.tick,now.wall-TTL,now.tick-TTL);
  if(db.prepare('SELECT count(*) AS n FROM device_enrollment_tickets').get().n>=MAX_TOTAL||db.prepare('SELECT count(*) AS n FROM device_enrollment_tickets WHERE owner_hash=?').get(ownerHash).n>=MAX_OWNER)deny();
  const token=randomBytes(32).toString('base64url'),hash=tokenHash(token);
  db.prepare('INSERT INTO device_enrollment_tickets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run(hash,ownerHash,sessionHash,b.pairId,b.challengeId,b.transcriptHash,b.cameraId,b.prompterId,b.cameraHash,b.prompterHash,now.runtimeId,now.wall,now.tick);
  auth(authorize,ownerHash,sessionHash,b);const last=checkedClock(clock),row=db.prepare('SELECT * FROM device_enrollment_tickets WHERE token_hash=?').get(hash);
  const current=db.prepare('SELECT * FROM relay_pair_challenges WHERE pair_id=? AND challenge_id=? AND owner_hash=? AND transcript_hash=?').get(b.pairId,b.challengeId,ownerHash,b.transcriptHash);
  if(!same(row,ownerHash,sessionHash,b)||row.runtime_id!==now.runtimeId||row.created_wall!==now.wall||row.created_tick!==now.tick||!fresh(row,last)||!current||!fresh(current,last)||db.prepare('SELECT 1 FROM relay_pair_links WHERE pair_id=?').get(b.pairId))deny();
  return {version:1,origin:ORIGIN,token,expiresAt:now.wall+TTL,cameraFingerprint:b.cameraHash,prompterFingerprint:b.prompterHash};
 }).immediate();
}

/** Atomic with pair creation. Only a trusted, revalidated admin session and both signed device proofs can consume it. */
export function completeQrEnrollmentFixture(db,{ownerHash,sessionHash,token,input},clock,authorize){
 requireFixture(db);if(!HASH.test(ownerHash)||!HASH.test(sessionHash)||typeof clock!=='function')deny();const hash=tokenHash(token),b=binding(input);if(!hash)deny();
 let sawNewPair=false,expired=false;
 const checked=()=>{
  const row=db.prepare('SELECT * FROM device_enrollment_tickets WHERE token_hash=?').get(hash);
  if(!same(row,ownerHash,sessionHash,b))deny();
  let now=checkedClock(clock);if(!fresh(row,now)){expired=row.runtime_id===now.runtimeId;deny();}
  auth(authorize,ownerHash,sessionHash,b);
  const after=db.prepare('SELECT * FROM device_enrollment_tickets WHERE token_hash=?').get(hash);
  now=checkedClock(clock);if(!same(after,ownerHash,sessionHash,b)||after.runtime_id!==row.runtime_id||after.created_wall!==row.created_wall||after.created_tick!==row.created_tick||!fresh(after,now)){if(same(after,ownerHash,sessionHash,b)&&after.runtime_id===row.runtime_id&&after.created_wall===row.created_wall&&after.created_tick===row.created_tick&&after.runtime_id===now.runtimeId&&!fresh(after,now))expired=true;deny();}
  const pair=db.prepare('SELECT * FROM relay_pair_links WHERE pair_id=?').get(b.pairId);
  if(pair){
   if(!sawNewPair||pair.owner_hash!==ownerHash||pair.camera_id!==b.cameraId||pair.prompter_id!==b.prompterId||pair.transcript_hash!==b.transcriptHash||pair.revoked_at!==null)deny();
   if(db.prepare('UPDATE device_enrollment_tickets SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now.wall,hash).changes!==1)deny();
  }else sawNewPair=true;
  return true;
 };
 try{return completeRelayPairing(db,ownerHash,input,clock,checked);}
 catch(error){
  // A rejected expired proof must not become live again after wall-clock rollback.
  if(expired&&!db.inTransaction)db.transaction(()=>{db.prepare('DELETE FROM device_enrollment_tickets WHERE token_hash=? AND owner_hash=? AND session_hash=? AND consumed_at IS NULL').run(hash,ownerHash,sessionHash);}).immediate();
  throw error;
 }
}


/** Read-only recovery for a lost completion response, under the same admin session. */
export function readQrEnrollmentReceiptFixture(db,{ownerHash,sessionHash,token,input},clock,authorize){
 requireFixture(db);if(!HASH.test(ownerHash)||!HASH.test(sessionHash)||typeof clock!=='function')deny();const hash=tokenHash(token),b=binding(input);if(!hash)deny();
 for(const side of [input.camera,input.prompter])if(!Buffer.isBuffer(side.signature)||side.signature.length<1||side.signature.length>80)deny();
 const proof=sha(Buffer.from(JSON.stringify([ownerHash,b.pairId,b.challengeId,b.transcriptHash,b.cameraId,input.camera.publicKey.toString('base64'),input.camera.signature.toString('base64'),b.prompterId,input.prompter.publicKey.toString('base64'),input.prompter.signature.toString('base64')]),'utf8'));
 const result=db.transaction(()=>{
  const row=db.prepare('SELECT * FROM device_enrollment_tickets WHERE token_hash=?').get(hash);if(!same(row,ownerHash,sessionHash,b,true))return null;
  let now=checkedClock(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_enrollment_tickets WHERE token_hash=? AND consumed_at IS NOT NULL').run(hash);return null;}
  auth(authorize,ownerHash,sessionHash,b);
  const check=()=>{
   const current=db.prepare('SELECT * FROM device_enrollment_tickets WHERE token_hash=?').get(hash);
   if(!same(current,ownerHash,sessionHash,b,true)||current.runtime_id!==row.runtime_id||current.created_wall!==row.created_wall||current.created_tick!==row.created_tick||current.consumed_at!==row.consumed_at)return false;
   const pair=db.prepare('SELECT * FROM relay_pair_links WHERE pair_id=?').get(b.pairId),p=db.prepare('SELECT * FROM relay_pair_completions WHERE pair_id=?').get(b.pairId);
   if(!pair||pair.owner_hash!==ownerHash||pair.camera_id!==b.cameraId||pair.prompter_id!==b.prompterId||pair.transcript_hash!==b.transcriptHash||pair.revoked_at!==null||!p||p.challenge_id!==b.challengeId||p.proof_hash!==proof)return false;
   const devices=db.prepare('SELECT * FROM relay_pair_devices WHERE device_id IN (?,?)').all(b.cameraId,b.prompterId);
   return devices.length===2&&devices.every(d=>d.owner_hash===ownerHash&&d.revoked_at===null&&sha(d.public_key)===(d.device_id===b.cameraId?b.cameraHash:b.prompterHash));
  };
  if(!check())return null;now=checkedClock(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_enrollment_tickets WHERE token_hash=? AND consumed_at IS NOT NULL').run(hash);return null;}
  if(!check())return null;return {pairId:b.pairId,created:true};
 }).immediate();
 if(!result)deny();return result;
}
