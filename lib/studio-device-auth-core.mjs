// Isolated test core. No HTTP routes, admin sessions, Android integration or migrations.
import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';

export const DEVICE_CAPABILITIES = Object.freeze(['projects:read','recordings:upload']);
const allowed = new Set(DEVICE_CAPABILITIES), uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/, CHALLENGE_MS=60_000, TICKET_MS=300_000, MAX_DEVICES=100, MAX_TICKETS=8, MAX_CHALLENGES=200;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw new Error('Ungültiger Gerätenachweis.');};
const id=value=>typeof value==='string' && uuid.test(value);
const caps=value=>{
 if(!Array.isArray(value)||value.length<1||value.length>allowed.size||value.some(v=>typeof v!=='string'||!allowed.has(v))||new Set(value).size!==value.length) fail();
 return [...value].sort().join(',');
};
const keyFrom=bytes=>{
 try {
  if(!Buffer.isBuffer(bytes)||bytes.length>256) return fail();
  const key=createPublicKey({key:bytes,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(bytes))return fail();
  return key;
 } catch { return fail(); }
};
const authorized=fn=>{try{return typeof fn==='function' && fn()===true;}catch{return false;}};
const message=row=>Buffer.from(`videomaker-studio-device-auth/v1\n${row.action}\n${row.device_id}\n${row.challenge_id}\n${row.nonce}\n${digest(row.public_key)}\n${row.capabilities}\n${row.owner_hash}\n`,'utf8');

/** Explicit initialization for isolated tests; never called by production. */
export function initializeStudioDeviceAuth(db){db.exec(`
 CREATE TABLE IF NOT EXISTS studio_auth_clock(id INTEGER PRIMARY KEY CHECK(id=1), floor_ms INTEGER NOT NULL);
 INSERT OR IGNORE INTO studio_auth_clock(id,floor_ms) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS studio_auth_devices(device_id TEXT PRIMARY KEY, public_key BLOB NOT NULL UNIQUE, capabilities TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
 CREATE TABLE IF NOT EXISTS studio_auth_challenges(device_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE, action TEXT NOT NULL CHECK(action IN('enroll','login')), nonce TEXT NOT NULL, public_key BLOB NOT NULL, capabilities TEXT NOT NULL, owner_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS studio_auth_tickets(ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_ms INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES studio_auth_devices(device_id));
 `);}
function observe(db,clock){
 const now=clock();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-TICKET_MS) return null;
 const {floor_ms:floor}=db.prepare('SELECT floor_ms FROM studio_auth_clock WHERE id=1').get();
 if(now<floor)return null;
 db.prepare('UPDATE studio_auth_clock SET floor_ms=? WHERE id=1').run(now);
 return now;
}
const fresh=(row,now)=>now!==null&&now>=row.created_ms&&now-row.created_ms<CHALLENGE_MS;
const rowSame=(a,b)=>a&&b&&a.challenge_id===b.challenge_id&&a.action===b.action&&a.nonce===b.nonce&&a.owner_hash===b.owner_hash&&a.capabilities===b.capabilities&&a.created_ms===b.created_ms&&Buffer.from(a.public_key).equals(Buffer.from(b.public_key));

/** All callbacks are trusted adapters, not client data; they must recheck live authority. */
export function createStudioDeviceAuth(db,clock=Date.now){
 function challenge(action,deviceId,publicKey,capabilities,ownerHash,authorize){
  if(!id(deviceId))return null;
  if(action==='enroll') { if(!hex.test(ownerHash)||!authorized(authorize))return null; keyFrom(publicKey); capabilities=caps(capabilities); }
  return db.transaction(()=>{
   const now=observe(db,clock);if(now===null)return null;
   if(action==='enroll'&&!authorized(authorize))return null;
   const device=db.prepare('SELECT * FROM studio_auth_devices WHERE device_id=?').get(deviceId);
   if(action==='enroll'){
    if(device||db.prepare('SELECT 1 FROM studio_auth_devices WHERE public_key=?').get(publicKey))return null;
    if(db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n>=MAX_DEVICES)return null;
   } else {
    if(!device||device.revoked)return null;
    publicKey=Buffer.from(device.public_key);capabilities=device.capabilities;ownerHash='';
   }
   db.prepare('DELETE FROM studio_auth_challenges WHERE created_ms<=?').run(now-CHALLENGE_MS);
   if(db.prepare('SELECT count(*) n FROM studio_auth_challenges').get().n>=MAX_CHALLENGES)return null;
   // At most one live challenge per device; failed requests cannot displace a valid one.
   const old=db.prepare('SELECT * FROM studio_auth_challenges WHERE device_id=?').get(deviceId);
   if(old&&fresh(old,now))return null;
   db.prepare('DELETE FROM studio_auth_challenges WHERE device_id=?').run(deviceId);
   if(action==='enroll'&&!authorized(authorize))return null;
   const last=observe(db,clock);if(last===null||last-now>=CHALLENGE_MS)return null;
   if(action==='enroll'&&(db.prepare('SELECT 1 FROM studio_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,publicKey)))return null;
   if(action==='login'&&!db.prepare('SELECT 1 FROM studio_auth_devices WHERE device_id=? AND revoked=0').get(deviceId))return null;
   const row={device_id:deviceId,challenge_id:randomUUID(),nonce:randomBytes(32).toString('base64url'),action,public_key:publicKey,capabilities,owner_hash:ownerHash,created_ms:last};
   db.prepare('INSERT INTO studio_auth_challenges VALUES (@device_id,@challenge_id,@action,@nonce,@public_key,@capabilities,@owner_hash,@created_ms)').run(row);
   return {challengeId:row.challenge_id, message:message(row), expiresInMs:CHALLENGE_MS};
  }).immediate();
 }
 function complete(action,deviceId,challengeId,signature,ownerHash,authorize){
  if(!id(deviceId)||!id(challengeId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)return null;
  if(action==='enroll'&&(!hex.test(ownerHash)||!authorized(authorize)))return null;
  return db.transaction(()=>{
   const initial=observe(db,clock);if(initial===null)return null;
   let row=db.prepare('SELECT * FROM studio_auth_challenges WHERE device_id=? AND challenge_id=? AND action=?').get(deviceId,challengeId,action);
   if(!row||row.owner_hash!==ownerHash||!fresh(row,initial))return null;
   if(action==='enroll'&&!authorized(authorize))return null;
   if(!verify('sha256',message(row),{key:keyFrom(Buffer.from(row.public_key)),dsaEncoding:'der'},signature))return null;
   if(action==='enroll'&&!authorized(authorize))return null;
   const now=observe(db,clock), current=db.prepare('SELECT * FROM studio_auth_challenges WHERE device_id=?').get(deviceId);
   if(!rowSame(row,current)||!fresh(row,now))return null;
   const device=db.prepare('SELECT * FROM studio_auth_devices WHERE device_id=?').get(deviceId);
   if(action==='enroll'){
    if(device||db.prepare('SELECT 1 FROM studio_auth_devices WHERE public_key=?').get(row.public_key)||db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n>=MAX_DEVICES)return null;
   } else if(!device||device.revoked||device.capabilities!==row.capabilities||!Buffer.from(device.public_key).equals(Buffer.from(row.public_key))) return null;
   if(action==='login'){
    db.prepare('DELETE FROM studio_auth_tickets WHERE expires_ms<=?').run(now);
    if(db.prepare('SELECT count(*) n FROM studio_auth_tickets WHERE device_id=?').get(deviceId).n>=MAX_TICKETS)return null;
   }
   if(db.prepare('DELETE FROM studio_auth_challenges WHERE device_id=? AND challenge_id=?').run(deviceId,challengeId).changes!==1)return null;
   if(action==='enroll'){
    db.prepare('INSERT INTO studio_auth_devices VALUES (?,?,?,0)').run(deviceId,row.public_key,row.capabilities);
    return {enrolled:true};
   }
   const ticket=randomBytes(32).toString('base64url');
   db.prepare('INSERT INTO studio_auth_tickets VALUES (?,?,?)').run(digest(ticket),deviceId,now+TICKET_MS);
   return {ticket,expiresInMs:TICKET_MS};
  }).immediate();
 }
 return Object.freeze({
  beginEnrollment:(deviceId,publicKey,capabilities,ownerHash,authorize)=>challenge('enroll',deviceId,publicKey,capabilities,ownerHash,authorize),
  completeEnrollment:(deviceId,challengeId,signature,ownerHash,authorize)=>complete('enroll',deviceId,challengeId,signature,ownerHash,authorize),
  beginLogin:deviceId=>challenge('login',deviceId,null,null,'',null),
  completeLogin:(deviceId,challengeId,signature)=>complete('login',deviceId,challengeId,signature,'',null),
  revoke:(deviceId,authorize)=>{
   if(!id(deviceId)||!authorized(authorize))return false;
   return db.transaction(()=>{if(observe(db,clock)===null||!authorized(authorize))return false;
    const changed=db.prepare('UPDATE studio_auth_devices SET revoked=1 WHERE device_id=? AND revoked=0').run(deviceId).changes;
    if(changed){db.prepare('DELETE FROM studio_auth_challenges WHERE device_id=?').run(deviceId);db.prepare('DELETE FROM studio_auth_tickets WHERE device_id=?').run(deviceId);}return !!changed;
   }).immediate();
  },
  // This is a capability check, not an admin login or permission to commit later.
  permits:(ticket,capability)=>{
   if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket)||!allowed.has(capability))return false;
   return db.transaction(()=>{const now=observe(db,clock);if(now===null)return false;
    const row=db.prepare('SELECT d.capabilities,d.revoked,t.expires_ms FROM studio_auth_tickets t JOIN studio_auth_devices d ON d.device_id=t.device_id WHERE t.ticket_hash=?').get(digest(ticket));
    return !!row&&!row.revoked&&now<row.expires_ms&&row.capabilities.split(',').includes(capability);
   }).immediate();
  }
 });
}
