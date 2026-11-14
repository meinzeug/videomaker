import type Database from 'better-sqlite3';
import {createHash,createPublicKey,randomBytes,randomUUID,timingSafeEqual,verify} from 'node:crypto';
import {expiredRelayOperation,relayExpiringTransaction,tablePresent} from './relay-expiry.ts';

type Role='camera'|'prompter';
type Clock={runtimeId:string;wall:number;tick:number};
type Request={pairId:string;deviceId:string;role:Role;roomId:string;tokenHash:string};
type ClockRow={runtime_id:string;created_wall:number;created_tick:number};
const uuid=(x:string)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const hash=(x:string)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const room=(x:string)=>typeof x==='string'&&/^[A-Za-z0-9_-]{22}$/.test(x);
const secret=(x:string)=>typeof x==='string'&&/^[A-Za-z0-9_-]{43}$/.test(x);
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const CHALLENGE_MS=59_990,TICKET_MS=299_990,MAX_PENDING=2000;
const fail=(code:string):never=>{throw new Error(code);};
const clockValid=(x:Clock)=>uuid(x.runtimeId)&&Number.isSafeInteger(x.wall)&&x.wall>=0&&Number.isSafeInteger(x.tick)&&x.tick>=0;
const fresh=(x:ClockRow,c:Clock,ttl:number)=>x.runtime_id===c.runtimeId&&c.wall>=x.created_wall&&c.tick>=x.created_tick&&c.wall-x.created_wall<ttl&&c.tick-x.created_tick<ttl;
function validate(owner:string,session:string,r:Request,c:Clock){if(!hash(owner)||!hash(session)||!uuid(r.pairId)||!uuid(r.deviceId)||!['camera','prompter'].includes(r.role)||!room(r.roomId)||!hash(r.tokenHash)||!clockValid(c))fail('INVALID');}
const schema=`
 CREATE TABLE IF NOT EXISTS relay_session_challenges(pair_id TEXT NOT NULL,role TEXT NOT NULL,challenge_id TEXT NOT NULL UNIQUE,owner_hash TEXT NOT NULL,session_hash TEXT NOT NULL,device_id TEXT NOT NULL,room_id TEXT NOT NULL,token_hash TEXT NOT NULL,nonce TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,PRIMARY KEY(pair_id,role));
 CREATE TABLE IF NOT EXISTS relay_session_tokens(pair_id TEXT NOT NULL,role TEXT NOT NULL,challenge_id TEXT NOT NULL,owner_hash TEXT NOT NULL,session_hash TEXT NOT NULL,device_id TEXT NOT NULL,room_id TEXT NOT NULL,token_hash TEXT NOT NULL,proof_hash TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,PRIMARY KEY(pair_id,role));
`;
function paired(db:Database.Database,owner:string,r:Request){
 const value=db.prepare(`SELECT d.public_key AS publicKey FROM relay_pair_links p JOIN relay_pair_devices d ON d.device_id=CASE WHEN ?='camera' THEN p.camera_id ELSE p.prompter_id END WHERE p.pair_id=? AND p.owner_hash=? AND p.revoked_at IS NULL AND d.owner_hash=? AND d.device_id=? AND d.revoked_at IS NULL`).get(r.role,r.pairId,owner,owner,r.deviceId) as {publicKey:Buffer}|undefined;
 return value??fail('PAIR_REVOKED');
}
/** A caller must hold the same DB transaction as the Studio-session authorization. */
export function beginRelaySession(db:Database.Database,owner:string,session:string,r:Request,clock:()=>Clock,authorize:()=>boolean){
 return relayExpiringTransaction(db,()=>{
  if(authorize()!==true)fail('UNAUTHORIZED');let c=clock();validate(owner,session,r,c);paired(db,owner,r);db.exec(schema);
  const old=db.prepare('SELECT * FROM relay_session_challenges WHERE pair_id=? AND role=?').get(r.pairId,r.role) as (ClockRow&{owner_hash:string;session_hash:string;device_id:string;room_id:string;token_hash:string;challenge_id:string;nonce:string})|undefined;
  if(old&&fresh(old,c,CHALLENGE_MS)&&old.owner_hash===owner&&old.session_hash===session&&old.device_id===r.deviceId&&old.room_id===r.roomId&&old.token_hash===r.tokenHash){
   if(authorize()!==true)fail('UNAUTHORIZED');paired(db,owner,r);c=clock();validate(owner,session,r,c);
   if(fresh(old,c,CHALLENGE_MS))return {challengeId:old.challenge_id,nonce:old.nonce,created:false};
  }
  db.prepare('DELETE FROM relay_session_challenges WHERE runtime_id=? AND (created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(c.runtimeId,c.wall,c.tick,c.wall-CHALLENGE_MS,c.tick-CHALLENGE_MS);
  const exists=db.prepare('SELECT 1 FROM relay_session_challenges WHERE pair_id=? AND role=?').get(r.pairId,r.role);
  if(!exists&&((db.prepare('SELECT COUNT(*) AS n FROM relay_session_challenges').get() as {n:number}).n>=MAX_PENDING||(db.prepare('SELECT COUNT(*) AS n FROM relay_session_challenges WHERE owner_hash=?').get(owner) as {n:number}).n>=8))fail('CAPACITY');
  const challengeId=randomUUID(),nonce=randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO relay_session_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pair_id,role) DO UPDATE SET challenge_id=excluded.challenge_id,owner_hash=excluded.owner_hash,session_hash=excluded.session_hash,device_id=excluded.device_id,room_id=excluded.room_id,token_hash=excluded.token_hash,nonce=excluded.nonce,runtime_id=excluded.runtime_id,created_wall=excluded.created_wall,created_tick=excluded.created_tick`).run(r.pairId,r.role,challengeId,owner,session,r.deviceId,r.roomId,r.tokenHash,nonce,c.runtimeId,c.wall,c.tick);
  if(authorize()!==true)fail('UNAUTHORIZED');paired(db,owner,r);const final=clock();validate(owner,session,r,final);
  if(!fresh({runtime_id:c.runtimeId,created_wall:c.wall,created_tick:c.tick},final,CHALLENGE_MS))return expiredRelayOperation();
  return {challengeId,nonce,created:true};
 },()=>{if(tablePresent(db,'relay_session_challenges'))db.prepare('DELETE FROM relay_session_challenges WHERE pair_id=? AND role=? AND owner_hash=? AND session_hash=?').run(r.pairId,r.role,owner,session);});
}
/** Signatures bind account, current login, room, role, device and chosen credential hash. */
export function relaySessionMessage(owner:string,session:string,r:Request,challengeId:string,nonce:string){
 return Buffer.from(`videomaker-relay-session/v1\n${owner}\n${session}\n${r.pairId}\n${r.role}\n${r.deviceId}\n${r.roomId}\n${r.tokenHash}\n${challengeId}\n${nonce}\n`,'utf8');
}
export function completeRelaySession(db:Database.Database,owner:string,session:string,r:Request,challengeId:string,signature:Buffer,clock:()=>Clock,authorize:()=>boolean){
 if(!uuid(challengeId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)fail('INVALID');
 const proofHash=sha(JSON.stringify([owner,session,r.pairId,r.role,r.deviceId,r.roomId,r.tokenHash,challengeId,signature.toString('base64')]));
 return relayExpiringTransaction(db,()=>{
  if(authorize()!==true)fail('UNAUTHORIZED');const initial=clock();validate(owner,session,r,initial);const device=paired(db,owner,r);db.exec(schema);
  const old=db.prepare('SELECT * FROM relay_session_tokens WHERE pair_id=? AND role=?').get(r.pairId,r.role) as (ClockRow&{challenge_id:string;owner_hash:string;session_hash:string;device_id:string;room_id:string;token_hash:string;proof_hash:string})|undefined;
  if(old&&old.challenge_id===challengeId&&old.owner_hash===owner&&old.session_hash===session&&old.device_id===r.deviceId&&old.room_id===r.roomId&&old.token_hash===r.tokenHash&&old.proof_hash===proofHash&&fresh(old,initial,TICKET_MS)){const now=clock();if(!clockValid(now)||!fresh(old,now,TICKET_MS))return expiredRelayOperation();if(authorize()!==true)fail('UNAUTHORIZED');paired(db,owner,r);const final=clock();if(!clockValid(final)||!fresh(old,final,TICKET_MS))return expiredRelayOperation();return {created:false};}
  const pending=db.prepare('SELECT * FROM relay_session_challenges WHERE pair_id=? AND role=? AND challenge_id=? AND owner_hash=? AND session_hash=? AND device_id=? AND room_id=? AND token_hash=?').get(r.pairId,r.role,challengeId,owner,session,r.deviceId,r.roomId,r.tokenHash) as (ClockRow&{nonce:string})|undefined;
  if(!pending||!fresh(pending,initial,CHALLENGE_MS))return expiredRelayOperation();
  let valid=false;try{const key=createPublicKey({key:device.publicKey,format:'der',type:'spki'});valid=verify('sha256',relaySessionMessage(owner,session,r,challengeId,pending.nonce),{key,dsaEncoding:'der'},signature);}catch{/* malformed proof fails closed */}
  if(!valid)fail('PROOF');
  const now=clock();if(!clockValid(now)||!fresh(pending,now,CHALLENGE_MS))return expiredRelayOperation();if(authorize()!==true)fail('UNAUTHORIZED');paired(db,owner,r);
  db.prepare(`INSERT INTO relay_session_tokens VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pair_id,role) DO UPDATE SET challenge_id=excluded.challenge_id,owner_hash=excluded.owner_hash,session_hash=excluded.session_hash,device_id=excluded.device_id,room_id=excluded.room_id,token_hash=excluded.token_hash,proof_hash=excluded.proof_hash,runtime_id=excluded.runtime_id,created_wall=excluded.created_wall,created_tick=excluded.created_tick`).run(r.pairId,r.role,challengeId,owner,session,r.deviceId,r.roomId,r.tokenHash,proofHash,now.runtimeId,now.wall,now.tick);
  db.prepare('DELETE FROM relay_session_challenges WHERE pair_id=? AND role=? AND challenge_id=?').run(r.pairId,r.role,challengeId);
  if(authorize()!==true)return fail('UNAUTHORIZED');paired(db,owner,r);const final=clock();if(!clockValid(final)||!fresh(pending,final,CHALLENGE_MS))return expiredRelayOperation();
  return {created:true};
 },()=>{
  if(tablePresent(db,'relay_session_challenges'))db.prepare('DELETE FROM relay_session_challenges WHERE pair_id=? AND role=? AND challenge_id=? AND owner_hash=? AND session_hash=?').run(r.pairId,r.role,challengeId,owner,session);
  if(tablePresent(db,'relay_session_tokens'))db.prepare('DELETE FROM relay_session_tokens WHERE pair_id=? AND role=? AND challenge_id=? AND owner_hash=? AND session_hash=? AND proof_hash=?').run(r.pairId,r.role,challengeId,owner,session,proofHash);
 });
}
export function verifyRelaySession(db:Database.Database,owner:string,session:string,r:Request,credential:string,clock:()=>Clock,authorize:()=>boolean){
 if(db.inTransaction)fail('NESTED_RELAY_TRANSACTION_UNSUPPORTED');
 if(!secret(credential)||!hash(r.tokenHash)||!timingSafeEqual(Buffer.from(sha(credential),'hex'),Buffer.from(r.tokenHash,'hex')))return false;
 return db.transaction(()=>{
  if(authorize()!==true)return false;const initial=clock();validate(owner,session,r,initial);paired(db,owner,r);
  const token=db.prepare('SELECT * FROM relay_session_tokens WHERE pair_id=? AND role=? AND owner_hash=? AND session_hash=? AND device_id=? AND room_id=? AND token_hash=?').get(r.pairId,r.role,owner,session,r.deviceId,r.roomId,r.tokenHash) as ClockRow|undefined;
  if(!token)return false;
  const discard=()=>{db.prepare('DELETE FROM relay_session_tokens WHERE pair_id=? AND role=? AND owner_hash=? AND session_hash=? AND device_id=? AND room_id=? AND token_hash=?').run(r.pairId,r.role,owner,session,r.deviceId,r.roomId,r.tokenHash);return false;};
  if(!fresh(token,initial,TICKET_MS))return discard();
  const now=clock();if(!clockValid(now)||!fresh(token,now,TICKET_MS))return discard();if(authorize()!==true)return false;paired(db,owner,r);const final=clock();return clockValid(final)&&fresh(token,final,TICKET_MS)?true:discard();
 }).immediate();
}
/** Logout invalidates temporary grants, while the durable device trust remains. */
export function revokeRelayOwnerSession(db:Database.Database,session:string){
 if(!hash(session)||!db.inTransaction)fail('INVALID');
 for(const table of ['relay_session_tokens','relay_session_challenges'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`DELETE FROM ${table} WHERE session_hash=?`).run(session);
}

type Participant={session:string;request:Request;credential:string;authorize:()=>boolean};
/** A room is authorized only while both distinct devices have fresh matching grants. */
export function verifyRelaySessionPair(db:Database.Database,owner:string,camera:Participant,prompter:Participant,clock:()=>Clock){
 if(db.inTransaction)fail('NESTED_RELAY_TRANSACTION_UNSUPPORTED');
 const c=camera.request,p=prompter.request;
 if(c.role!=='camera'||p.role!=='prompter'||c.deviceId===p.deviceId||c.pairId!==p.pairId||c.roomId!==p.roomId)return false;
 if(!secret(camera.credential)||!secret(prompter.credential)||!hash(c.tokenHash)||!hash(p.tokenHash))return false;
 if(!timingSafeEqual(Buffer.from(sha(camera.credential),'hex'),Buffer.from(c.tokenHash,'hex'))||!timingSafeEqual(Buffer.from(sha(prompter.credential),'hex'),Buffer.from(p.tokenHash,'hex')))return false;
 return db.transaction(()=>{
  if(camera.authorize()!==true||prompter.authorize()!==true)return false;
  const initial=clock();validate(owner,camera.session,c,initial);validate(owner,prompter.session,p,initial);paired(db,owner,c);paired(db,owner,p);
  const find=db.prepare('SELECT * FROM relay_session_tokens WHERE pair_id=? AND role=? AND owner_hash=? AND session_hash=? AND device_id=? AND room_id=? AND token_hash=?');
  const cameraToken=find.get(c.pairId,c.role,owner,camera.session,c.deviceId,c.roomId,c.tokenHash) as ClockRow|undefined;
  const prompterToken=find.get(p.pairId,p.role,owner,prompter.session,p.deviceId,p.roomId,p.tokenHash) as ClockRow|undefined;
  const discardExpired=(at:Clock)=>{
   for(const [participant,token] of [[camera,cameraToken],[prompter,prompterToken]] as const)if(token&&(!clockValid(at)||!fresh(token,at,TICKET_MS))){
    const r=participant.request;db.prepare('DELETE FROM relay_session_tokens WHERE pair_id=? AND role=? AND owner_hash=? AND session_hash=? AND device_id=? AND room_id=? AND token_hash=?').run(r.pairId,r.role,owner,participant.session,r.deviceId,r.roomId,r.tokenHash);
   }
   return false;
  };
  if(!cameraToken||!prompterToken||!fresh(cameraToken,initial,TICKET_MS)||!fresh(prompterToken,initial,TICKET_MS))return discardExpired(initial);
  if(camera.authorize()!==true||prompter.authorize()!==true)return false;
  paired(db,owner,c);paired(db,owner,p);const final=clock();
  return clockValid(final)&&fresh(cameraToken,final,TICKET_MS)&&fresh(prompterToken,final,TICKET_MS)?true:discardExpired(final);
 }).immediate();
}
