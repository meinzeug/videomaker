import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { sessionHashRevokedReadOnly } from './session-revocations.ts';

// Isolated building block: no initialization, listener or authentication flow at import time.
// Initialize explicitly in the SAME SQLite database that owns auth_session_revocations.
const schema=`
 CREATE TABLE IF NOT EXISTS oidc_session_bindings (
  reference_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, key_generation INTEGER NOT NULL DEFAULT 0
 );
 CREATE INDEX IF NOT EXISTS oidc_session_bindings_session ON oidc_session_bindings(session_hash,expires_at);
 CREATE TABLE IF NOT EXISTS oidc_binding_time_floor (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL);
 INSERT OR IGNORE INTO oidc_binding_time_floor(id,observed_at) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS oidc_binding_key_state (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, generation INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS oidc_binding_session_epochs (
  session_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, key_generation INTEGER NOT NULL, epoch INTEGER NOT NULL
 );
`;
type Proof={sessionHash:string;expiresAt:number};
type Verify=(db:Database.Database,cookie:string)=>Proof|null;
const referencePattern=/^[A-Za-z0-9_-]{43}$/;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export function initializeOidcSessionBindings(db:Database.Database):void {
 db.transaction(()=>{
  db.exec(schema);
  const columns=db.prepare('PRAGMA table_info(oidc_session_bindings)').all() as Array<{name:string}>;
  // Legacy bindings have generation 0 and cannot survive the explicit upgrade.
  if(!columns.some(column=>column.name==='key_generation'))db.exec('ALTER TABLE oidc_session_bindings ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 0');
 }).immediate();
}

/** The verifier must check the original signed cookie and revocation inside this transaction. */
export function createOidcSessionBindings(db:Database.Database,verify:Verify,clock:()=>number=Date.now,sessionSecret:()=>string|undefined=()=>process.env.SESSION_SECRET) {
 const now=():number=>{
  const sample=clock();
  if(!Number.isSafeInteger(sample)||sample<0)throw new Error('Ungültige OIDC-Zeit');
  const row=db.prepare('UPDATE oidc_binding_time_floor SET observed_at=MAX(observed_at,?) WHERE id=1 RETURNING observed_at').get(sample) as {observed_at:number}|undefined;
  if(!row)throw new Error('OIDC-Zeitmarkierung fehlt');
  return row.observed_at;
 };
 /** Caller must hold the same write transaction as issue/check and logout. */
 const generation=():number=>{
  const secret=sessionSecret();
  if(!secret||secret.length<32)throw new Error('OIDC-Sitzungsschlüssel fehlt');
  const fingerprint=createHmac('sha256',secret).update('videomaker-oidc-session-key-generation/v1\0').digest('hex');
  const row=db.prepare('SELECT fingerprint,generation FROM oidc_binding_key_state WHERE id=1').get() as {fingerprint:string;generation:number}|undefined;
  if(!row){db.prepare('INSERT INTO oidc_binding_key_state(id,fingerprint,generation) VALUES(1,?,1)').run(fingerprint);return 1;}
  if(!Number.isSafeInteger(row.generation)||row.generation<1)throw new Error('Ungültige OIDC-Schlüsselgeneration');
  if(row.fingerprint===fingerprint)return row.generation;
  if(row.generation>=Number.MAX_SAFE_INTEGER)throw new Error('OIDC-Schlüsselgeneration erschöpft');
  const next=row.generation+1;
  db.prepare('UPDATE oidc_binding_key_state SET fingerprint=?,generation=? WHERE id=1').run(fingerprint,next);
  return next;
 };
 // Persist every observed change before fallible verification. A later rollback
 // may deny the request but must not roll back a successfully observed rotation.
 const observeGeneration=():void=>{
  if(db.inTransaction)throw new Error('OIDC-Schlüsselprüfung erfordert eine eigene Transaktion');
  db.transaction(()=>{generation();}).immediate();
 };
 /** A deleted reset epoch must never be forgotten while its login could become valid again. */
 const prune=(current:number,currentGeneration:number):void=>{
  for(const table of ['oidc_session_bindings','oidc_binding_session_epochs'])db.prepare(`DELETE FROM ${table} WHERE expires_at<=? OR key_generation<>? OR EXISTS
   (SELECT 1 FROM auth_session_revocations r WHERE r.session_hash=${table}.session_hash)`).run(current,currentGeneration);
 };
 const sessionEpoch=(proof:Proof,currentGeneration:number):number=>{
  const row=db.prepare('SELECT epoch,expires_at,key_generation FROM oidc_binding_session_epochs WHERE session_hash=?').get(proof.sessionHash) as {epoch:number;expires_at:number;key_generation:number}|undefined;
  if(row){
   if(!Number.isSafeInteger(row.epoch)||row.epoch<0||row.expires_at!==proof.expiresAt||row.key_generation!==currentGeneration)throw new Error('Ungültige OIDC-Sitzungsepoche');
   return row.epoch;
  }
  const total=db.prepare('SELECT COUNT(*) AS n FROM oidc_binding_session_epochs').get() as {n:number};
  if(total.n>=1024)throw new Error('Zu viele OIDC-Sitzungsepochen');
  db.prepare('INSERT INTO oidc_binding_session_epochs(session_hash,expires_at,key_generation,epoch) VALUES(?,?,?,0)').run(proof.sessionHash,proof.expiresAt,currentGeneration);
  return 0;
 };
 return {
  /** Explicitly observe a rotation at startup, even when there are no user requests. */
  observeKeyGeneration():void {observeGeneration();},
  /** Returns a high-entropy opaque handle; never persist or log the browser cookie. */
  issue(cookie:string):string|null {
   observeGeneration();
   if(typeof cookie!=='string'||cookie.length===0||cookie.length>512)return null;
   now();
   return db.transaction(()=>{
    const current=now(), currentGeneration=generation(), proof=verify(db,cookie);
    if(!proof)return null;
    if(!/^[a-f0-9]{64}$/.test(proof.sessionHash)||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=current) return null;
    // Verify again here: a faulty or stale verifier must not bypass a committed logout.
    if(sessionHashRevokedReadOnly(db,proof.sessionHash))return null;
    // Expired/revoked entries cannot revive: observed time and logout tombstones remain.
    prune(current,currentGeneration);
    const epoch=sessionEpoch(proof,currentGeneration),secret=sessionSecret();
    if(!secret||secret.length<32)throw new Error('OIDC-Sitzungsschlüssel fehlt');
    const reference=createHmac('sha256',secret).update('videomaker-oidc-reference/v2\0').update(`${currentGeneration}\0${epoch}\0${proof.sessionHash}`).digest('base64url');
    const existing=db.prepare('SELECT session_hash,expires_at,key_generation FROM oidc_session_bindings WHERE reference_hash=?').get(digest(reference)) as {session_hash:string;expires_at:number;key_generation:number}|undefined;
    if(existing){
     if(existing.session_hash!==proof.sessionHash||existing.expires_at!==proof.expiresAt||existing.key_generation!==currentGeneration)throw new Error('Ungültige OIDC-Referenzzuordnung');
     return reference;
    }
    const total=db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings').get() as {n:number};
    const own=db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings WHERE session_hash=?').get(proof.sessionHash) as {n:number};
    if(total.n>=1024||own.n>=16)throw new Error('Zu viele OIDC-Sitzungsreferenzen');
    db.prepare('INSERT INTO oidc_session_bindings(reference_hash,session_hash,expires_at,key_generation) VALUES(?,?,?,?)')
     .run(digest(reference),proof.sessionHash,proof.expiresAt,currentGeneration);
    return reference;
   }).immediate();
  },
  /** Every use checks the live session's expiry and revocation, never a cached success. */
  isActive(reference:string):boolean {
   observeGeneration();
   if(typeof reference!=='string'||!referencePattern.test(reference))return false;
   return db.transaction(()=>{
    const current=now(),currentGeneration=generation();
    const row=db.prepare('SELECT session_hash,expires_at,key_generation FROM oidc_session_bindings WHERE reference_hash=?').get(digest(reference)) as {session_hash:string;expires_at:number;key_generation:number}|undefined;
    return !!row&&row.key_generation===currentGeneration&&row.expires_at>current&&!sessionHashRevokedReadOnly(db,row.session_hash);
   }).immediate();
  },
  /** Check the original browser session and reference together in the logout transaction domain. */
  matchesCookie(reference:string,cookie:string):boolean {
   observeGeneration();
   if(typeof reference!=='string'||!referencePattern.test(reference)||typeof cookie!=='string'||!cookie||cookie.length>512)return false;
   return db.transaction(()=>{
    const current=now(),currentGeneration=generation(),proof=verify(db,cookie);
    if(!proof||!/^[a-f0-9]{64}$/.test(proof.sessionHash)||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=current)return false;
    const row=db.prepare('SELECT session_hash,expires_at,key_generation FROM oidc_session_bindings WHERE reference_hash=?').get(digest(reference)) as {session_hash:string;expires_at:number;key_generation:number}|undefined;
    if(!row||row.key_generation!==currentGeneration||row.expires_at<=current||!/^[a-f0-9]{64}$/.test(row.session_hash))return false;
    if(!timingSafeEqual(Buffer.from(row.session_hash,'hex'),Buffer.from(proof.sessionHash,'hex')))return false;
    return !sessionHashRevokedReadOnly(db,row.session_hash);
   }).immediate();
  },
  /** Retire this signed-in browser's references after a provider restart; never rebind old provider UIDs. */
  resetForCookie(cookie:string):boolean {
   observeGeneration();
   if(typeof cookie!=='string'||cookie.length===0||cookie.length>512)return false;
   now();
   return db.transaction(()=>{
    const current=now(),currentGeneration=generation();
    const proof=verify(db,cookie);
    if(!proof||!/^[a-f0-9]{64}$/.test(proof.sessionHash)||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=current||sessionHashRevokedReadOnly(db,proof.sessionHash))return false;
    prune(current,currentGeneration);
    const epoch=sessionEpoch(proof,currentGeneration);
    if(epoch>=Number.MAX_SAFE_INTEGER)throw new Error('OIDC-Sitzungsepoche erschöpft');
    db.prepare('UPDATE oidc_binding_session_epochs SET epoch=? WHERE session_hash=?').run(epoch+1,proof.sessionHash);
    db.prepare('DELETE FROM oidc_session_bindings WHERE session_hash=?').run(proof.sessionHash);
    return true;
   }).immediate();
  },
 };
}
