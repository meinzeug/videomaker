// Isolated test core: no HTTP routes, admin sessions, Android integration or migrations.
import {createHash,createHmac,createPublicKey,randomBytes,randomUUID,timingSafeEqual,verify} from 'node:crypto';

export const DEVICE_CAPABILITIES=Object.freeze(['projects:read','recordings:upload']);
const allowed=new Set(DEVICE_CAPABILITIES), uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hex=/^[0-9a-f]{64}$/;
const CHALLENGE_MS=60_000,TICKET_MS=300_000,MAX_DEVICES=100,MAX_ENROLLMENTS=200,MAX_TICKETS=8,MAX_CONSUMED=1000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw new Error('Ungültiger Gerätenachweis.');};
const id=value=>typeof value==='string'&&uuid.test(value);
const caps=value=>{if(!Array.isArray(value)||value.length<1||value.length>allowed.size||value.some(v=>typeof v!=='string'||!allowed.has(v))||new Set(value).size!==value.length)fail();return [...value].sort().join(',');};
const keyFrom=bytes=>{try{if(!Buffer.isBuffer(bytes)||bytes.length>256)return fail();const key=createPublicKey({key:bytes,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(bytes))return fail();return key;}catch{return fail();}};
const authorized=fn=>{try{return typeof fn==='function'&&fn()===true;}catch{return false;}};
const enrollmentMessage=row=>Buffer.from(`videomaker-studio-device-auth/enroll/v1\n${row.device_id}\n${row.challenge_id}\n${row.nonce}\n${digest(row.public_key)}\n${row.capabilities}\n${row.owner_hash}\n`,'utf8');
const loginMessage=(deviceId,token,publicKey,capabilities)=>Buffer.from(`videomaker-studio-device-auth/login/v1\n${deviceId}\n${token}\n${digest(publicKey)}\n${capabilities}\n`,'utf8');

/** Explicit initialization for isolated tests; never called by production. */
export function initializeStudioDeviceAuth(db){db.exec(`
 CREATE TABLE IF NOT EXISTS studio_auth_clock(id INTEGER PRIMARY KEY CHECK(id=1), floor_ms INTEGER NOT NULL);
 INSERT OR IGNORE INTO studio_auth_clock(id,floor_ms) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS studio_auth_devices(device_id TEXT PRIMARY KEY, public_key BLOB NOT NULL UNIQUE, capabilities TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
 CREATE TABLE IF NOT EXISTS studio_auth_challenges(device_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL, public_key BLOB NOT NULL, capabilities TEXT NOT NULL, owner_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS studio_auth_consumed(challenge_id TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS studio_auth_tickets(ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_ms INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES studio_auth_devices(device_id));
 `);}
function readClock(db,clock){const now=clock();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-TICKET_MS)return null;const {floor_ms:floor}=db.prepare('SELECT floor_ms FROM studio_auth_clock WHERE id=1').get();return now<floor?null:now;}
function observe(db,clock){const now=readClock(db,clock);if(now===null)return null;db.prepare('UPDATE studio_auth_clock SET floor_ms=? WHERE id=1').run(now);return now;}
const fresh=(created,now)=>now!==null&&now>=created&&now-created<CHALLENGE_MS;
const rowSame=(a,b)=>a&&b&&a.challenge_id===b.challenge_id&&a.nonce===b.nonce&&a.owner_hash===b.owner_hash&&a.capabilities===b.capabilities&&a.created_ms===b.created_ms&&Buffer.from(a.public_key).equals(Buffer.from(b.public_key));

/** Secret and callbacks belong to a trusted server adapter, never to the client. */
export function createStudioDeviceAuth(db,clock=Date.now,challengeSecret){
 if(!Buffer.isBuffer(challengeSecret)||challengeSecret.length<32)throw new Error('Challenge-Schlüssel fehlt.');
 const secret=Buffer.from(challengeSecret);
 const mac=(device,head)=>createHmac('sha256',secret).update('videomaker-studio-login-challenge/v1\0').update(device).update('\0').update(head).digest();
 const decode=(device,token)=>{
  if(typeof token!=='string'||token.length>200)return null;
  const parts=token.split('.');if(parts.length!==4||!id(parts[0])||!/^(0|[1-9][0-9]{0,15})$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2])||!/^[A-Za-z0-9_-]{43}$/.test(parts[3]))return null;
  const created=Number(parts[1]),nonce=Buffer.from(parts[2],'base64url'),signature=Buffer.from(parts[3],'base64url');
  if(!Number.isSafeInteger(created)||nonce.length!==32||signature.length!==32||nonce.toString('base64url')!==parts[2]||signature.toString('base64url')!==parts[3])return null;
  const expected=mac(device,parts.slice(0,3).join('.'));if(!timingSafeEqual(signature,expected))return null;
  return {challengeId:parts[0],created};
 };
 function beginEnrollment(deviceId,publicKey,capabilities,ownerHash,authorize){
  if(!id(deviceId)||typeof ownerHash!=='string'||!hex.test(ownerHash)||!authorized(authorize))return null;
  keyFrom(publicKey);capabilities=caps(capabilities);
  return db.transaction(()=>{
   const now=observe(db,clock);if(now===null||!authorized(authorize))return null;
   if(db.prepare('SELECT 1 FROM studio_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,publicKey)||db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n>=MAX_DEVICES)return null;
   db.prepare('DELETE FROM studio_auth_challenges WHERE created_ms<=?').run(now-CHALLENGE_MS);
   if(db.prepare('SELECT count(*) n FROM studio_auth_challenges').get().n>=MAX_ENROLLMENTS||db.prepare('SELECT 1 FROM studio_auth_challenges WHERE device_id=?').get(deviceId))return null;
   if(!authorized(authorize))return null;
   const last=observe(db,clock);if(last===null||last-now>=CHALLENGE_MS||db.prepare('SELECT 1 FROM studio_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,publicKey))return null;
   const row={device_id:deviceId,challenge_id:randomUUID(),nonce:randomBytes(32).toString('base64url'),public_key:publicKey,capabilities,owner_hash:ownerHash,created_ms:last};
   db.prepare('INSERT INTO studio_auth_challenges VALUES (@device_id,@challenge_id,@nonce,@public_key,@capabilities,@owner_hash,@created_ms)').run(row);
   return {challengeId:row.challenge_id,message:enrollmentMessage(row),expiresInMs:CHALLENGE_MS};
  }).immediate();
 }
 function completeEnrollment(deviceId,challengeId,signature,ownerHash,authorize){
  if(!id(deviceId)||!id(challengeId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80||typeof ownerHash!=='string'||!hex.test(ownerHash)||!authorized(authorize))return null;
  return db.transaction(()=>{
   const initial=observe(db,clock);if(initial===null)return null;
   const row=db.prepare('SELECT * FROM studio_auth_challenges WHERE device_id=? AND challenge_id=?').get(deviceId,challengeId);
   if(!row||row.owner_hash!==ownerHash||!fresh(row.created_ms,initial)||!authorized(authorize))return null;
   if(!verify('sha256',enrollmentMessage(row),{key:keyFrom(Buffer.from(row.public_key)),dsaEncoding:'der'},signature)||!authorized(authorize))return null;
   const now=observe(db,clock),current=db.prepare('SELECT * FROM studio_auth_challenges WHERE device_id=?').get(deviceId);
   if(!rowSame(row,current)||!fresh(row.created_ms,now)||db.prepare('SELECT 1 FROM studio_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,row.public_key)||db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n>=MAX_DEVICES)return null;
   if(db.prepare('DELETE FROM studio_auth_challenges WHERE device_id=? AND challenge_id=?').run(deviceId,challengeId).changes!==1)return null;
   db.prepare('INSERT INTO studio_auth_devices VALUES (?,?,?,0)').run(deviceId,row.public_key,row.capabilities);return {enrolled:true};
  }).immediate();
 }
 function beginLogin(deviceId){
  if(!id(deviceId))return null;
  // Unknown devices do not acquire the writer lock. For a known device, the
  // observed wall-time floor must be durable and shared before returning a
  // challenge, or a forward observation followed by rollback can revive an old one.
  const initial=db.prepare('SELECT revoked FROM studio_auth_devices WHERE device_id=?').get(deviceId);
  if(!initial||initial.revoked)return null;
  const snapshot=db.transaction(()=>{
   const now=observe(db,clock),device=db.prepare('SELECT * FROM studio_auth_devices WHERE device_id=?').get(deviceId);
   if(now===null||!device||device.revoked)return null;
   return {now,publicKey:Buffer.from(device.public_key),capabilities:device.capabilities};
  }).immediate();
  if(!snapshot)return null;
  // No challenge slot is reserved. Random generation and MAC run after releasing
  // the writer lock; a later revoke is rechecked before ticket issuance.
  const challengeId=randomUUID(),head=`${challengeId}.${snapshot.now}.${randomBytes(32).toString('base64url')}`,token=`${head}.${mac(deviceId,head).toString('base64url')}`;
  return {challengeId,challengeToken:token,message:loginMessage(deviceId,token,snapshot.publicKey,snapshot.capabilities),expiresInMs:CHALLENGE_MS};
 }
 function completeLogin(deviceId,token,signature){
  if(!id(deviceId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)return null;
  const claim=decode(deviceId,token);if(!claim)return null;
  const before=db.prepare('SELECT * FROM studio_auth_devices WHERE device_id=?').get(deviceId);
  if(!before||before.revoked||!verify('sha256',loginMessage(deviceId,token,Buffer.from(before.public_key),before.capabilities),{key:keyFrom(Buffer.from(before.public_key)),dsaEncoding:'der'},signature))return null;
  return db.transaction(()=>{
   const now=observe(db,clock),current=db.prepare('SELECT * FROM studio_auth_devices WHERE device_id=?').get(deviceId);
   if(!fresh(claim.created,now)||!current||current.revoked||current.capabilities!==before.capabilities||!Buffer.from(current.public_key).equals(Buffer.from(before.public_key)))return null;
   db.prepare('DELETE FROM studio_auth_consumed WHERE expires_ms<=?').run(now);
   db.prepare('DELETE FROM studio_auth_tickets WHERE expires_ms<=?').run(now);
   if(db.prepare('SELECT 1 FROM studio_auth_consumed WHERE challenge_id=?').get(claim.challengeId)||db.prepare('SELECT count(*) n FROM studio_auth_consumed').get().n>=MAX_CONSUMED||db.prepare('SELECT count(*) n FROM studio_auth_tickets WHERE device_id=?').get(deviceId).n>=MAX_TICKETS)return null;
   const last=observe(db,clock);if(!fresh(claim.created,last))return null;
   db.prepare('INSERT INTO studio_auth_consumed VALUES (?,?)').run(claim.challengeId,claim.created+CHALLENGE_MS);
   const ticket=randomBytes(32).toString('base64url');db.prepare('INSERT INTO studio_auth_tickets VALUES (?,?,?)').run(digest(ticket),deviceId,last+TICKET_MS);
   return {ticket,expiresInMs:TICKET_MS};
  }).immediate();
 }
 return Object.freeze({beginEnrollment,completeEnrollment,beginLogin,completeLogin,
  revoke:(deviceId,authorize)=>{
   if(!id(deviceId)||!authorized(authorize))return false;
   return db.transaction(()=>{if(observe(db,clock)===null||!authorized(authorize))return false;
    const changed=db.prepare('UPDATE studio_auth_devices SET revoked=1 WHERE device_id=? AND revoked=0').run(deviceId).changes;
    if(changed){db.prepare('DELETE FROM studio_auth_challenges WHERE device_id=?').run(deviceId);db.prepare('DELETE FROM studio_auth_tickets WHERE device_id=?').run(deviceId);}return !!changed;
   }).immediate();
  },
  // Momentary capability check, not an admin login or permission to commit later.
  permits:(ticket,capability)=>{
   if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket)||!allowed.has(capability))return false;
   const ticketHash=digest(ticket);
   // Reject unknown random tickets before acquiring SQLite's writer lock.
   if(!db.prepare('SELECT 1 FROM studio_auth_tickets WHERE ticket_hash=?').get(ticketHash))return false;
   return db.transaction(()=>{const now=observe(db,clock);if(now===null)return false;
    const row=db.prepare('SELECT d.capabilities,d.revoked,t.expires_ms FROM studio_auth_tickets t JOIN studio_auth_devices d ON d.device_id=t.device_id WHERE t.ticket_hash=?').get(ticketHash);
    return !!row&&!row.revoked&&now<row.expires_ms&&row.capabilities.split(',').includes(capability);
   }).immediate();
  }
 });
}
