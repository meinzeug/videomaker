import {createHmac,timingSafeEqual} from 'node:crypto';
import type Database from 'better-sqlite3';
import {relaySessionId,sessionRevocationId,sessionRevokedReadOnly} from './session-revocations.ts';

// No cookie or bearer is persisted. Revocation and expiry tombstones are kept;
// bounded capacity deliberately fails closed until a safe retention policy exists.
const schema=`CREATE TABLE IF NOT EXISTS relay_browser_sessions (
 session_hash TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,revocation_hash TEXT NOT NULL,
 secret_epoch TEXT NOT NULL,expires_at INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1))
)`;
const hex=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const epoch=(secret:string)=>createHmac('sha256',secret).update('relay-browser-epoch/v1\0').digest('hex');
const time=(clock:()=>number)=>{const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('INVALID_CLOCK');return now;};
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const table=(db:Database.Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function cookieExpiry(secret:string,cookie:string):number|null {
 if(secret.length<32||cookie.length>1024)return null;
 const parts=cookie.split('.');
 if(parts.length!==3||!/^[0-9]{1,16}$/.test(parts[0])||!/^[A-Za-z0-9_-]{24}$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))return null;
 const expires=Number(parts[0]);if(!Number.isSafeInteger(expires))return null;
 const expected=createHmac('sha256',secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
 return equal(parts[2],expected)?expires:null;
}

/**
 * Called only after the route derives owner from an authenticated account.
 * Registration and a final cookie/revocation/expiry check commit together.
 * An expired known session is tombstoned rather than revived by clock rollback.
 */
export function registerRelayBrowserSession(db:Database.Database,secret:string,cookie:string,owner:string,clock:()=>number){
 if(db.inTransaction)throw Error('NESTED_RELAY_TRANSACTION_UNSUPPORTED');
 if(!hex(owner))throw Error('INVALID_OWNER');
 const expires=cookieExpiry(secret,cookie);if(expires===null)return null;
 const id=relaySessionId(secret,cookie),revocation=sessionRevocationId(secret,cookie),generation=epoch(secret);
 return db.transaction(()=>{
  if(!table(db,'auth_session_revocations')||sessionRevokedReadOnly(db,secret,cookie))return null;
  const initial=time(clock);db.exec(schema);
  const old=db.prepare('SELECT * FROM relay_browser_sessions WHERE session_hash=?').get(id) as {owner_hash:string;revocation_hash:string;secret_epoch:string;expires_at:number;expired:number}|undefined;
  if(old&&(!equal(old.owner_hash,owner)||!equal(old.revocation_hash,revocation)||!equal(old.secret_epoch,generation)||old.expires_at!==expires))return null;
  if(old?.expired)return null;
  if(expires<=initial){if(old)db.prepare('UPDATE relay_browser_sessions SET expired=1 WHERE session_hash=?').run(id);return null;}
  if(!old){
   const global=(db.prepare('SELECT COUNT(*) AS n FROM relay_browser_sessions').get() as {n:number}).n;
   const perOwner=(db.prepare('SELECT COUNT(*) AS n FROM relay_browser_sessions WHERE owner_hash=?').get(owner) as {n:number}).n;
   if(global>=4096||perOwner>=128)throw Error('RELAY_SESSION_CAPACITY');
   db.prepare('INSERT INTO relay_browser_sessions VALUES(?,?,?,?,?,0)').run(id,owner,revocation,generation,expires);
  }
  const final=time(clock);
  const current=db.prepare('SELECT * FROM relay_browser_sessions WHERE session_hash=?').get(id) as {owner_hash:string;revocation_hash:string;secret_epoch:string;expires_at:number;expired:number}|undefined;
  if(!current||current.expired||!equal(current.owner_hash,owner)||!equal(current.revocation_hash,revocation)||!equal(current.secret_epoch,generation)||current.expires_at!==expires)return null;
  if(expires<=final){db.prepare('UPDATE relay_browser_sessions SET expired=1 WHERE session_hash=?').run(id);return null;}
  if(sessionRevokedReadOnly(db,secret,cookie))return null;
  return id;
 }).immediate();
}

/** Must run in the same transaction as relay grant verification. */
export function resolveRelayBrowserSession(db:Database.Database,secret:string,owner:string,id:string,clock:()=>number){
 if(!db.inTransaction)throw Error('RELAY_TRANSACTION_REQUIRED');
 if(secret.length<32||!hex(owner)||!hex(id)||!table(db,'relay_browser_sessions')||!table(db,'auth_session_revocations'))return false;
 const row=db.prepare('SELECT * FROM relay_browser_sessions WHERE session_hash=? AND owner_hash=?').get(id,owner) as {revocation_hash:string;secret_epoch:string;expires_at:number;expired:number}|undefined;
 if(!row||row.expired||!hex(row.revocation_hash)||!equal(row.secret_epoch,epoch(secret)))return false;
 const now=time(clock);
 const current=db.prepare('SELECT * FROM relay_browser_sessions WHERE session_hash=? AND owner_hash=?').get(id,owner) as {revocation_hash:string;secret_epoch:string;expires_at:number;expired:number}|undefined;
 if(!current||current.expired||!equal(current.revocation_hash,row.revocation_hash)||!equal(current.secret_epoch,row.secret_epoch)||current.expires_at!==row.expires_at)return false;
 if(!Number.isSafeInteger(row.expires_at)||row.expires_at<=now){db.prepare('UPDATE relay_browser_sessions SET expired=1 WHERE session_hash=? AND owner_hash=?').run(id,owner);return false;}
 return !db.prepare('SELECT 1 FROM auth_session_revocations WHERE session_hash=?').get(row.revocation_hash);
}
