import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// Preparatory building block only: the caller must prove the OIDC session is new
// before first insertion and must recheck the Video-Maker reference on every use.
const schema=`CREATE TABLE IF NOT EXISTS oidc_provider_session_map (
 uid_hash TEXT PRIMARY KEY, binding_reference TEXT NOT NULL
)`;
const uidPattern=/^[A-Za-z0-9_-]{16,128}$/;
const referencePattern=/^[A-Za-z0-9_-]{43}$/;
const uidHash=(uid:string)=>createHash('sha256').update('videomaker-oidc-session/v1\0').update(uid).digest('hex');

/** Explicitly initialize only in the isolated provider database. */
export function initializeOidcProviderSessionMap(db:Database.Database):void {db.exec(schema);}

export function createOidcProviderSessionMap(db:Database.Database) {
 return {
  /** A previously known OIDC session UID can never acquire a different reference. */
  bindOnce(uid:string,reference:string):void {
   if(!uidPattern.test(uid)||!referencePattern.test(reference))throw new Error('Ungültige OIDC-Sitzungszuordnung');
   db.transaction(()=>{
    const key=uidHash(uid);
    db.prepare('INSERT OR IGNORE INTO oidc_provider_session_map(uid_hash,binding_reference) VALUES(?,?)').run(key,reference);
    const row=db.prepare('SELECT binding_reference FROM oidc_provider_session_map WHERE uid_hash=?').get(key) as {binding_reference:string}|undefined;
    if(!row||row.binding_reference!==reference)throw new Error('OIDC-Sitzung bereits anders zugeordnet');
   }).immediate();
  },
  find(uid:string):string|undefined {
   if(typeof uid!=='string'||!uidPattern.test(uid))return undefined;
   const row=db.prepare('SELECT binding_reference FROM oidc_provider_session_map WHERE uid_hash=?').get(uidHash(uid)) as {binding_reference:string}|undefined;
   return row?.binding_reference;
  },
 };
}
