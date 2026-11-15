// Isolated v2 ownership experiment: separate tables, no routes, migration or production use.
import {createHash,createHmac,createPublicKey,randomBytes,randomUUID,timingSafeEqual,verify} from 'node:crypto';

export const DEVICE_CAPABILITIES=Object.freeze(['projects:read','recordings:upload']);
const allowed=new Set(DEVICE_CAPABILITIES), uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hex=/^[0-9a-f]{64}$/;
const CHALLENGE_MS=60_000,TICKET_MS=300_000,MAX_DEVICES=100,MAX_ENROLLMENTS=200,MAX_TICKETS=8,MAX_CONSUMED=1000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw new Error('Ungültiger Gerätenachweis.');};
const id=value=>typeof value==='string'&&uuid.test(value);
const caps=value=>{if(!Array.isArray(value)||value.length<1||value.length>allowed.size||value.some(v=>typeof v!=='string'||!allowed.has(v))||new Set(value).size!==value.length)fail();return [...value].sort().join(',');};
const keyFrom=bytes=>{try{if(!Buffer.isBuffer(bytes)||bytes.length>256)return fail();const key=createPublicKey({key:bytes,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(bytes))return fail();return key;}catch{return fail();}};
const enrollmentMessage=row=>Buffer.from(`videomaker-studio-device-auth/enroll/v2\n${row.device_id}\n${row.challenge_id}\n${row.nonce}\n${digest(row.public_key)}\n${row.capabilities}\n${row.owner_hash}\n${row.workspace_hash}\n${row.confirm_session_hash}\n`,'utf8');
const loginMessage=(deviceId,token,publicKey,capabilities,owner,workspace)=>Buffer.from(`videomaker-studio-device-auth/login/v2\n${deviceId}\n${token}\n${digest(publicKey)}\n${capabilities}\n${owner}\n${workspace}\n`,'utf8');

/** Explicit initialization for isolated tests; never called by production. */
export function initializeOwnedDeviceAuth(db){
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_owned_auth_devices'").get()){
  const columns=new Set(db.prepare('PRAGMA table_info(fixture_owned_auth_devices)').all().map(column=>column.name));
  if(!columns.has('owner_hash')||!columns.has('workspace_hash'))throw Error('UNOWNED_FIXTURE_SCHEMA_REVIEW_REQUIRED');
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_owned_auth_projects'").get()){
  const columns=new Set(db.prepare('PRAGMA table_info(fixture_owned_auth_projects)').all().map(column=>column.name));
  if(!columns.has('project_epoch')||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_owned_auth_project_epochs'").get())throw Error('PROJECT_EPOCH_SCHEMA_REVIEW_REQUIRED');
 }
 for(const [name,required] of [['fixture_owned_auth_challenges',['confirm_session_hash','owner_hash','workspace_hash']],['fixture_owned_auth_grants',['project_epoch','owner_hash','workspace_hash']],['fixture_owned_auth_project_epochs',['project_epoch','project_id','owner_hash','workspace_hash','used']]]){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)){
   const columns=new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(column=>column.name));
   if(required.some(column=>!columns.has(column)))throw Error('OWNED_FIXTURE_SCHEMA_REVIEW_REQUIRED');
  }
 }
 db.exec(`
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_clock(id INTEGER PRIMARY KEY CHECK(id=1), floor_ms INTEGER NOT NULL);
 INSERT OR IGNORE INTO fixture_owned_auth_clock(id,floor_ms) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_devices(device_id TEXT PRIMARY KEY, public_key BLOB NOT NULL UNIQUE, capabilities TEXT NOT NULL, owner_hash TEXT NOT NULL, workspace_hash TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_challenges(device_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL, public_key BLOB NOT NULL, capabilities TEXT NOT NULL, owner_hash TEXT NOT NULL, workspace_hash TEXT NOT NULL, confirm_session_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_consumed(challenge_id TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_tickets(ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_ms INTEGER NOT NULL, FOREIGN KEY(device_id) REFERENCES fixture_owned_auth_devices(device_id));
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_sessions(session_hash TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,expires_ms INTEGER NOT NULL,revoked INTEGER NOT NULL CHECK(revoked IN(0,1)));
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_project_epochs(project_epoch TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,used INTEGER NOT NULL CHECK(used IN(0,1)));
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_projects(project_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,project_epoch TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fixture_owned_auth_grants(device_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,project_epoch TEXT NOT NULL,revoked INTEGER NOT NULL CHECK(revoked IN(0,1)),PRIMARY KEY(device_id,project_id));
 CREATE TRIGGER IF NOT EXISTS fixture_owned_device_immutable BEFORE UPDATE OF device_id,public_key,capabilities,owner_hash,workspace_hash ON fixture_owned_auth_devices BEGIN SELECT RAISE(ABORT,'device binding immutable'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_session_immutable BEFORE UPDATE OF session_hash,owner_hash,workspace_hash,expires_ms ON fixture_owned_auth_sessions BEGIN SELECT RAISE(ABORT,'session binding immutable'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_session_no_delete BEFORE DELETE ON fixture_owned_auth_sessions BEGIN SELECT RAISE(ABORT,'session tombstone retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_session_no_reactivate BEFORE UPDATE OF revoked ON fixture_owned_auth_sessions WHEN OLD.revoked=1 AND NEW.revoked<>1 BEGIN SELECT RAISE(ABORT,'session revocation retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_session_insert_guard BEFORE INSERT ON fixture_owned_auth_sessions WHEN EXISTS(SELECT 1 FROM fixture_owned_auth_sessions s WHERE s.session_hash=NEW.session_hash OR s.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'session exists'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_device_no_delete BEFORE DELETE ON fixture_owned_auth_devices BEGIN SELECT RAISE(ABORT,'device binding retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_device_no_reactivate BEFORE UPDATE OF revoked ON fixture_owned_auth_devices WHEN OLD.revoked=1 AND NEW.revoked<>1 BEGIN SELECT RAISE(ABORT,'device revocation retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_device_insert_guard BEFORE INSERT ON fixture_owned_auth_devices WHEN EXISTS(SELECT 1 FROM fixture_owned_auth_devices d WHERE d.device_id=NEW.device_id OR d.public_key=NEW.public_key OR d.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'device binding exists'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_grant_immutable BEFORE UPDATE OF device_id,project_id,owner_hash,workspace_hash,project_epoch ON fixture_owned_auth_grants BEGIN SELECT RAISE(ABORT,'project binding immutable'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_grant_no_delete BEFORE DELETE ON fixture_owned_auth_grants BEGIN SELECT RAISE(ABORT,'project binding retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_grant_no_reactivate BEFORE UPDATE OF revoked ON fixture_owned_auth_grants WHEN OLD.revoked=1 AND NEW.revoked<>1 BEGIN SELECT RAISE(ABORT,'project revocation retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_grant_insert_guard BEFORE INSERT ON fixture_owned_auth_grants WHEN EXISTS(SELECT 1 FROM fixture_owned_auth_grants g WHERE (g.device_id=NEW.device_id AND g.project_id=NEW.project_id) OR g.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'project binding exists'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_epoch_no_delete BEFORE DELETE ON fixture_owned_auth_project_epochs BEGIN SELECT RAISE(ABORT,'project epoch retained'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_epoch_no_rebind BEFORE UPDATE OF project_epoch,project_id,owner_hash,workspace_hash ON fixture_owned_auth_project_epochs BEGIN SELECT RAISE(ABORT,'project epoch immutable'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_epoch_no_reuse BEFORE UPDATE OF used ON fixture_owned_auth_project_epochs WHEN OLD.used<>0 OR NEW.used<>1 BEGIN SELECT RAISE(ABORT,'project epoch consumed'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_epoch_insert_guard BEFORE INSERT ON fixture_owned_auth_project_epochs WHEN EXISTS(SELECT 1 FROM fixture_owned_auth_project_epochs e WHERE e.project_epoch=NEW.project_epoch OR e.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'project epoch exists'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_project_immutable BEFORE UPDATE OF project_id,owner_hash,workspace_hash,project_epoch ON fixture_owned_auth_projects BEGIN SELECT RAISE(ABORT,'project identity immutable'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_project_insert_guard BEFORE INSERT ON fixture_owned_auth_projects WHEN EXISTS(SELECT 1 FROM fixture_owned_auth_projects p WHERE p.project_id=NEW.project_id OR p.rowid=NEW.rowid) OR NOT EXISTS(SELECT 1 FROM fixture_owned_auth_project_epochs e WHERE e.project_epoch=NEW.project_epoch AND e.project_id=NEW.project_id AND e.owner_hash=NEW.owner_hash AND e.workspace_hash=NEW.workspace_hash AND e.used=0) BEGIN SELECT RAISE(ABORT,'project epoch invalid'); END;
 CREATE TRIGGER IF NOT EXISTS fixture_owned_project_consume_epoch AFTER INSERT ON fixture_owned_auth_projects BEGIN UPDATE fixture_owned_auth_project_epochs SET used=1 WHERE project_epoch=NEW.project_epoch; END;
 `);}

/** Test-only project creation. Production must use its own authenticated lifecycle. */
export function createSyntheticOwnedProject(db,project,owner,workspace){
 if(db.inTransaction)throw Error('outer transaction forbidden');
 if(!id(project)||typeof owner!=='string'||!hex.test(owner)||typeof workspace!=='string'||!hex.test(workspace))throw Error('invalid fixture project');
 return db.transaction(()=>{
  const epoch=randomUUID();
  db.prepare('INSERT INTO fixture_owned_auth_project_epochs VALUES(?,?,?,?,0)').run(epoch,project,owner,workspace);
  db.prepare('INSERT INTO fixture_owned_auth_projects VALUES(?,?,?,?)').run(project,owner,workspace,epoch);
  return epoch;
 }).immediate();
}
function readClock(db,clock){const now=clock();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-TICKET_MS)return null;const {floor_ms:floor}=db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock WHERE id=1').get();return now<floor?null:now;}
function observe(db,clock){const now=readClock(db,clock);if(now===null)return null;db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=? WHERE id=1').run(now);return now;}
const fresh=(created,now)=>now!==null&&now>=created&&now-created<CHALLENGE_MS;
const rowSame=(a,b)=>a&&b&&a.challenge_id===b.challenge_id&&a.nonce===b.nonce&&a.owner_hash===b.owner_hash&&a.workspace_hash===b.workspace_hash&&a.confirm_session_hash===b.confirm_session_hash&&a.capabilities===b.capabilities&&a.created_ms===b.created_ms&&Buffer.from(a.public_key).equals(Buffer.from(b.public_key));

/** Secret and callbacks belong to a trusted server adapter, never to the client. */
export function createOwnedDeviceAuth(db,clock=Date.now,challengeSecret){
 if(!Buffer.isBuffer(challengeSecret)||challengeSecret.length<32)throw new Error('Challenge-Schlüssel fehlt.');
 const secret=Buffer.from(challengeSecret);
 // Returning an authorization result from a savepoint is unsafe: its effects
 // can still be undone by an enclosing transaction after the result escapes.
 const requireAutocommit=()=>{if(db.inTransaction)throw new Error('Geräteauthentifizierung benötigt eine eigene Transaktion.');};
 // Only a pure, short time source is permitted; it must not perform database,
 // filesystem, network or UI work or change any transaction boundary.
 const stableCallback=fn=>{const active=db.inTransaction;try{return fn();}finally{if(db.inTransaction!==active)throw new Error('Adapter hat die Transaktionsgrenze verändert.');}};
 const checkedClock=()=>stableCallback(clock);
 const standalone=fn=>(...args)=>{requireAutocommit();return fn(...args);};
 // A trusted callback invoked before the transaction must not start one either.
 const immediate=fn=>{requireAutocommit();return db.transaction(fn).immediate();};
 const sessionHash=token=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token)?digest(token):null;
 const session=(hash,now)=>{
  if(!hash||now===null)return null;
  const row=db.prepare('SELECT session_hash,owner_hash,workspace_hash,expires_ms,revoked FROM fixture_owned_auth_sessions WHERE session_hash=?').get(hash);
  return row&&!row.revoked&&typeof row.owner_hash==='string'&&hex.test(row.owner_hash)&&typeof row.workspace_hash==='string'&&hex.test(row.workspace_hash)&&Number.isSafeInteger(row.expires_ms)&&now<row.expires_ms?row:null;
 };
 const sameSession=(a,b)=>!!a&&!!b&&a.session_hash===b.session_hash&&a.owner_hash===b.owner_hash&&a.workspace_hash===b.workspace_hash&&a.expires_ms===b.expires_ms;
 const mac=(device,head)=>createHmac('sha256',secret).update('videomaker-studio-login-challenge/v2\0').update(device).update('\0').update(head).digest();
 const decode=(device,token)=>{
  if(typeof token!=='string'||token.length>200)return null;
  const parts=token.split('.');if(parts.length!==4||!id(parts[0])||!/^(0|[1-9][0-9]{0,15})$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2])||!/^[A-Za-z0-9_-]{43}$/.test(parts[3]))return null;
  const created=Number(parts[1]),nonce=Buffer.from(parts[2],'base64url'),signature=Buffer.from(parts[3],'base64url');
  if(!Number.isSafeInteger(created)||nonce.length!==32||signature.length!==32||nonce.toString('base64url')!==parts[2]||signature.toString('base64url')!==parts[3])return null;
  const expected=mac(device,parts.slice(0,3).join('.'));if(!timingSafeEqual(signature,expected))return null;
  return {challengeId:parts[0],created};
 };
 function beginEnrollment(deviceId,publicKey,capabilities,confirmingSession){
  const ownerSessionHash=sessionHash(confirmingSession);
  if(!id(deviceId)||!ownerSessionHash)return null;
  keyFrom(publicKey);capabilities=caps(capabilities);
  return immediate(()=>{
   const now=observe(db,checkedClock),principal=session(ownerSessionHash,now);if(!principal)return null;
   if(db.prepare('SELECT 1 FROM fixture_owned_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,publicKey)||db.prepare('SELECT count(*) n FROM fixture_owned_auth_devices').get().n>=MAX_DEVICES)return null;
   db.prepare('DELETE FROM fixture_owned_auth_challenges WHERE created_ms<=?').run(now-CHALLENGE_MS);
   if(db.prepare('SELECT count(*) n FROM fixture_owned_auth_challenges').get().n>=MAX_ENROLLMENTS||db.prepare('SELECT 1 FROM fixture_owned_auth_challenges WHERE device_id=?').get(deviceId))return null;
   const last=observe(db,checkedClock);if(last===null||last-now>=CHALLENGE_MS||!sameSession(principal,session(ownerSessionHash,last))||db.prepare('SELECT 1 FROM fixture_owned_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,publicKey))return null;
   const row={device_id:deviceId,challenge_id:randomUUID(),nonce:randomBytes(32).toString('base64url'),public_key:publicKey,capabilities,owner_hash:principal.owner_hash,workspace_hash:principal.workspace_hash,confirm_session_hash:ownerSessionHash,created_ms:last};
   db.exec('SAVEPOINT fixture_enrollment_begin');
   db.prepare('INSERT INTO fixture_owned_auth_challenges VALUES (@device_id,@challenge_id,@nonce,@public_key,@capabilities,@owner_hash,@workspace_hash,@confirm_session_hash,@created_ms)').run(row);
   const finalNow=observe(db,checkedClock);
   if(!fresh(last,finalNow)||!sameSession(principal,session(ownerSessionHash,finalNow))){
    db.exec('ROLLBACK TO fixture_enrollment_begin; RELEASE fixture_enrollment_begin');
    if(finalNow!==null)db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
    return null;
   }
   db.exec('RELEASE fixture_enrollment_begin');
   return {challengeId:row.challenge_id,message:enrollmentMessage(row),expiresInMs:CHALLENGE_MS};
  });
 }
 function completeEnrollment(deviceId,challengeId,signature,confirmingSession){
  const ownerSessionHash=sessionHash(confirmingSession);
  if(!id(deviceId)||!id(challengeId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80||!ownerSessionHash)return null;
  return immediate(()=>{
   const initial=observe(db,checkedClock);if(initial===null)return null;
   const principal=session(ownerSessionHash,initial);if(!principal)return null;
   const row=db.prepare('SELECT * FROM fixture_owned_auth_challenges WHERE device_id=? AND challenge_id=?').get(deviceId,challengeId);
   if(!row||row.owner_hash!==principal.owner_hash||row.workspace_hash!==principal.workspace_hash||row.confirm_session_hash!==ownerSessionHash||!fresh(row.created_ms,initial))return null;
   if(!verify('sha256',enrollmentMessage(row),{key:keyFrom(Buffer.from(row.public_key)),dsaEncoding:'der'},signature))return null;
   const now=observe(db,checkedClock);if(!sameSession(principal,session(ownerSessionHash,now)))return null;
   const current=db.prepare('SELECT * FROM fixture_owned_auth_challenges WHERE device_id=?').get(deviceId);
   if(!rowSame(row,current)||!fresh(row.created_ms,now)||db.prepare('SELECT 1 FROM fixture_owned_auth_devices WHERE device_id=? OR public_key=?').get(deviceId,row.public_key)||db.prepare('SELECT count(*) n FROM fixture_owned_auth_devices').get().n>=MAX_DEVICES)return null;
   db.exec('SAVEPOINT fixture_enrollment_complete');
   if(db.prepare('DELETE FROM fixture_owned_auth_challenges WHERE device_id=? AND challenge_id=?').run(deviceId,challengeId).changes!==1)throw Error('challenge changed inside transaction');
   db.prepare('INSERT INTO fixture_owned_auth_devices VALUES (?,?,?,?,?,0)').run(deviceId,row.public_key,row.capabilities,row.owner_hash,row.workspace_hash);
   const finalNow=observe(db,checkedClock);
   if(!fresh(row.created_ms,finalNow)||!sameSession(principal,session(ownerSessionHash,finalNow))){
    db.exec('ROLLBACK TO fixture_enrollment_complete; RELEASE fixture_enrollment_complete');
    if(finalNow!==null)db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
    return null;
   }
   db.exec('RELEASE fixture_enrollment_complete');return {enrolled:true};
  });
 }
 function beginLogin(deviceId){
  if(!id(deviceId))return null;
  // Unknown devices do not acquire the writer lock. For a known device, the
  // observed wall-time floor must be durable and shared before returning a
  // challenge, or a forward observation followed by rollback can revive an old one.
  const initial=db.prepare('SELECT revoked FROM fixture_owned_auth_devices WHERE device_id=?').get(deviceId);
  if(!initial||initial.revoked)return null;
  const snapshot=immediate(()=>{
   const now=observe(db,checkedClock),device=db.prepare('SELECT * FROM fixture_owned_auth_devices WHERE device_id=?').get(deviceId);
   if(now===null||!device||device.revoked)return null;
   if(typeof device.owner_hash!=='string'||!hex.test(device.owner_hash)||typeof device.workspace_hash!=='string'||!hex.test(device.workspace_hash))return null;
   return {now,publicKey:Buffer.from(device.public_key),capabilities:device.capabilities,owner:device.owner_hash,workspace:device.workspace_hash};
  });
  if(!snapshot)return null;
  // No challenge slot is reserved. Random generation and MAC run after releasing
  // the writer lock; a later revoke is rechecked before ticket issuance.
  const challengeId=randomUUID(),head=`${challengeId}.${snapshot.now}.${randomBytes(32).toString('base64url')}`,token=`${head}.${mac(deviceId,head).toString('base64url')}`;
  return {challengeId,challengeToken:token,message:loginMessage(deviceId,token,snapshot.publicKey,snapshot.capabilities,snapshot.owner,snapshot.workspace),expiresInMs:CHALLENGE_MS};
 }
 function completeLogin(deviceId,token,signature){
  if(!id(deviceId)||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)return null;
  const claim=decode(deviceId,token);if(!claim)return null;
  const before=db.prepare('SELECT * FROM fixture_owned_auth_devices WHERE device_id=?').get(deviceId);
  if(!before||before.revoked||typeof before.owner_hash!=='string'||!hex.test(before.owner_hash)||typeof before.workspace_hash!=='string'||!hex.test(before.workspace_hash)||!verify('sha256',loginMessage(deviceId,token,Buffer.from(before.public_key),before.capabilities,before.owner_hash,before.workspace_hash),{key:keyFrom(Buffer.from(before.public_key)),dsaEncoding:'der'},signature))return null;
  return immediate(()=>{
   const now=observe(db,checkedClock),current=db.prepare('SELECT * FROM fixture_owned_auth_devices WHERE device_id=?').get(deviceId);
   if(!fresh(claim.created,now)||!current||current.revoked||current.capabilities!==before.capabilities||current.owner_hash!==before.owner_hash||current.workspace_hash!==before.workspace_hash||!Buffer.from(current.public_key).equals(Buffer.from(before.public_key)))return null;
   db.prepare('DELETE FROM fixture_owned_auth_consumed WHERE expires_ms<=?').run(now);
   db.prepare('DELETE FROM fixture_owned_auth_tickets WHERE expires_ms<=?').run(now);
   if(db.prepare('SELECT 1 FROM fixture_owned_auth_consumed WHERE challenge_id=?').get(claim.challengeId)||db.prepare('SELECT count(*) n FROM fixture_owned_auth_consumed').get().n>=MAX_CONSUMED||db.prepare('SELECT count(*) n FROM fixture_owned_auth_tickets WHERE device_id=?').get(deviceId).n>=MAX_TICKETS)return null;
   const last=observe(db,checkedClock),finalDevice=db.prepare('SELECT * FROM fixture_owned_auth_devices WHERE device_id=?').get(deviceId);
   if(!fresh(claim.created,last)||!finalDevice||finalDevice.revoked||finalDevice.capabilities!==before.capabilities||finalDevice.owner_hash!==before.owner_hash||finalDevice.workspace_hash!==before.workspace_hash||!Buffer.from(finalDevice.public_key).equals(Buffer.from(before.public_key)))return null;
   db.prepare('INSERT INTO fixture_owned_auth_consumed VALUES (?,?)').run(claim.challengeId,claim.created+CHALLENGE_MS);
   const ticket=randomBytes(32).toString('base64url');db.prepare('INSERT INTO fixture_owned_auth_tickets VALUES (?,?,?)').run(digest(ticket),deviceId,last+TICKET_MS);
   return {ticket,expiresInMs:TICKET_MS};
  });
 }
 const projectEpoch=(device,project,owner,workspace)=>db.prepare(`SELECT p.project_epoch FROM fixture_owned_auth_devices d JOIN fixture_owned_auth_projects p
  ON p.owner_hash=d.owner_hash AND p.workspace_hash=d.workspace_hash
  WHERE d.device_id=? AND d.revoked=0 AND p.project_id=? AND d.owner_hash=? AND d.workspace_hash=?`).get(device,project,owner,workspace)?.project_epoch;
 const deviceMatches=(device,owner,workspace)=>!!db.prepare('SELECT 1 FROM fixture_owned_auth_devices WHERE device_id=? AND owner_hash=? AND workspace_hash=? AND revoked=0').get(device,owner,workspace);
 function grantProject(device,project,confirmingSession){
  const ownerSessionHash=sessionHash(confirmingSession);
  if(!id(device)||!id(project)||!ownerSessionHash)return false;
  return immediate(()=>{
   const now=observe(db,checkedClock),principal=session(ownerSessionHash,now);if(!principal)return false;
   const owner=principal.owner_hash,workspace=principal.workspace_hash;
   const epoch=projectEpoch(device,project,owner,workspace);if(!id(epoch))return false;
   if(db.prepare('SELECT 1 FROM fixture_owned_auth_grants WHERE device_id=? AND project_id=?').get(device,project))return false;
   if(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_grants').get().n>=1000)return false;
   db.exec('SAVEPOINT fixture_project_grant');
   db.prepare('INSERT INTO fixture_owned_auth_grants VALUES(?,?,?,?,?,0)').run(device,project,owner,workspace,epoch);
   const finalNow=observe(db,checkedClock);
   if(!sameSession(principal,session(ownerSessionHash,finalNow))||projectEpoch(device,project,owner,workspace)!==epoch){
    db.exec('ROLLBACK TO fixture_project_grant; RELEASE fixture_project_grant');
    if(finalNow!==null)db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
    return false;
   }
   db.exec('RELEASE fixture_project_grant');return true;
  });
 }
 function revokeProject(device,project,confirmingSession){
  const ownerSessionHash=sessionHash(confirmingSession);
  if(!id(device)||!id(project)||!ownerSessionHash)return false;
  return immediate(()=>{
   const now=observe(db,checkedClock),principal=session(ownerSessionHash,now);if(!principal)return false;
   const owner=principal.owner_hash,workspace=principal.workspace_hash;
   if(!deviceMatches(device,owner,workspace))return false;
   db.exec('SAVEPOINT fixture_project_revoke');
   const changed=db.prepare('UPDATE fixture_owned_auth_grants SET revoked=1 WHERE device_id=? AND project_id=? AND owner_hash=? AND workspace_hash=? AND revoked=0').run(device,project,owner,workspace).changes;
   const finalNow=observe(db,checkedClock);
   if(!sameSession(principal,session(ownerSessionHash,finalNow))||!deviceMatches(device,owner,workspace)){
    db.exec('ROLLBACK TO fixture_project_revoke; RELEASE fixture_project_revoke');
    if(finalNow!==null)db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
    return false;
   }
   db.exec('RELEASE fixture_project_revoke');return !!changed;
  });
 }
 return Object.freeze({beginEnrollment:standalone(beginEnrollment),completeEnrollment:standalone(completeEnrollment),beginLogin:standalone(beginLogin),completeLogin:standalone(completeLogin),grantProject:standalone(grantProject),revokeProject:standalone(revokeProject),
  revoke:standalone((deviceId,confirmingSession)=>{
   const ownerSessionHash=sessionHash(confirmingSession);if(!id(deviceId)||!ownerSessionHash)return false;
   return immediate(()=>{
    const now=observe(db,checkedClock),principal=session(ownerSessionHash,now);if(!principal)return false;
    const owner=principal.owner_hash,workspace=principal.workspace_hash;
    db.exec('SAVEPOINT fixture_device_revoke');
    const changed=db.prepare('UPDATE fixture_owned_auth_devices SET revoked=1 WHERE device_id=? AND owner_hash=? AND workspace_hash=? AND revoked=0').run(deviceId,owner,workspace).changes;
    if(changed){db.prepare('DELETE FROM fixture_owned_auth_challenges WHERE device_id=?').run(deviceId);db.prepare('DELETE FROM fixture_owned_auth_tickets WHERE device_id=?').run(deviceId);}
    const finalNow=observe(db,checkedClock);
    if(!sameSession(principal,session(ownerSessionHash,finalNow))){
     db.exec('ROLLBACK TO fixture_device_revoke; RELEASE fixture_device_revoke');
     if(finalNow!==null)db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
     return false;
    }
    db.exec('RELEASE fixture_device_revoke');return !!changed;
   });
  }),
  logoutSession:standalone(confirmingSession=>{
   const ownerSessionHash=sessionHash(confirmingSession);if(!ownerSessionHash)return false;
   return immediate(()=>{const now=observe(db,checkedClock);if(!session(ownerSessionHash,now))return false;
    return !!db.prepare('UPDATE fixture_owned_auth_sessions SET revoked=1 WHERE session_hash=? AND revoked=0').run(ownerSessionHash).changes;
   });
  }),
  // A momentary project check is not permission to commit a file later.
  permits:standalone((ticket,capability,project)=>{
   if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket)||!allowed.has(capability)||!id(project))return false;
   const ticketHash=digest(ticket);
   if(!db.prepare('SELECT 1 FROM fixture_owned_auth_tickets WHERE ticket_hash=?').get(ticketHash))return false;
   const check=now=>{
    if(now===null)return false;
    const row=db.prepare(`SELECT d.capabilities,d.revoked,t.expires_ms,g.revoked AS grant_revoked
     FROM fixture_owned_auth_tickets t JOIN fixture_owned_auth_devices d ON d.device_id=t.device_id
     JOIN fixture_owned_auth_grants g ON g.device_id=d.device_id AND g.project_id=? AND g.owner_hash=d.owner_hash AND g.workspace_hash=d.workspace_hash
     JOIN fixture_owned_auth_projects p ON p.project_id=g.project_id AND p.owner_hash=g.owner_hash AND p.workspace_hash=g.workspace_hash AND p.project_epoch=g.project_epoch
     WHERE t.ticket_hash=?`).get(project,ticketHash);
    return !!row&&!row.revoked&&!row.grant_revoked&&now<row.expires_ms&&row.capabilities.split(',').includes(capability);
   };
   return immediate(()=>{if(!check(observe(db,checkedClock)))return false;return check(observe(db,checkedClock));});
  })
 });
}
