import type Database from 'better-sqlite3';
import { sessionCookieValid } from './session-cookie.ts';
import { sessionRevokedReadOnly, sessionRevocationHash } from './session-revocations.ts';

/** Call within the SQLite transaction shared with logout; never persist the original cookie. */
export function verifiedSessionBindingProof(db:Database.Database,value:string,secret:string|undefined,now:number=Date.now()):{sessionHash:string;expiresAt:number}|null {
 if(!secret||!sessionCookieValid(value,secret,now)||sessionRevokedReadOnly(db,secret,value))return null;
 const expiresAt=Number(value.split('.')[0]);
 if(!Number.isSafeInteger(expiresAt))return null;
 return {sessionHash:sessionRevocationHash(secret,value),expiresAt};
}
