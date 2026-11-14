import {createHmac} from 'node:crypto';
import type Database from 'better-sqlite3';

// The cookie itself is a bearer credential. Only keyed digests are retained.
// Tombstones deliberately have no automatic expiry: a later wall-clock rollback
// must never make an already-logged-out cookie valid again.
const schema = `CREATE TABLE IF NOT EXISTS auth_session_revocations (
 session_hash TEXT PRIMARY KEY,
 revoked_at INTEGER NOT NULL
)`;
const digest=(secret:string,domain:string,value:string)=>createHmac('sha256',secret).update(domain).update(value).digest('hex');
const sessionHash=(secret:string,value:string)=>digest(secret,'auth-session-revocation/v1\0',value);
const cameraOwner=(secret:string,value:string)=>digest(secret,'camera-session/v1\0',value);
/** Domain-separated identifier: never store the session cookie as a relay key. */
export const relaySessionId=(secret:string,value:string)=>digest(secret,'relay-session/v1\0',value);

export function sessionRevoked(db:Database.Database,secret:string,value:string):boolean {
 db.exec(schema);
 return sessionRevokedReadOnly(db,secret,value);
}

/** Read without creating or changing schema. Missing schema must fail closed. */
export function sessionRevokedReadOnly(db:Database.Database,secret:string,value:string):boolean {
 return !!db.prepare('SELECT 1 FROM auth_session_revocations WHERE session_hash=?').get(sessionHash(secret,value));
}

/** Atomically revoke this cookie and remove its outstanding camera credentials. */
export function revokeSession(db:Database.Database,secret:string,value:string,now:number):void {
 db.exec(schema);
 const session=sessionHash(secret,value),owner=cameraOwner(secret,value),relaySession=relaySessionId(secret,value);
 db.transaction(()=>{
  db.prepare('INSERT OR IGNORE INTO auth_session_revocations(session_hash,revoked_at) VALUES(?,?)').run(session,now);
  for(const table of ['camera_device_tickets','camera_pairing_challenges'] as const){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    db.prepare(`DELETE FROM ${table} WHERE owner_hash=?`).run(owner);
  }
  // Relay sign-in must use relaySessionId for its session_hash. Logout removes
  // both roles' temporary grants in the same commit as cookie revocation.
  for(const table of ['relay_session_tokens','relay_session_challenges'] as const){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    db.prepare(`DELETE FROM ${table} WHERE session_hash=?`).run(relaySession);
  }
 }).immediate();
}
