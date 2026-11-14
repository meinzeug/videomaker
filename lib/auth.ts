import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import db from './db';
import { revokeSession, sessionRevoked } from './session-revocations';
import { signSessionBody, validSessionSignature, sessionCookieValid } from './session-cookie';
import { verifiedSessionBindingProof } from './session-binding-proof';
import type Database from 'better-sqlite3';
import { sameOriginPolicy } from './origin-policy';

const name = 'kontrakurs_session';
function safeEqual(a: string, b: string) { const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa,bb); }
export function passwordMatches(value: string) { return !!process.env.ADMIN_PASSWORD && safeEqual(value, process.env.ADMIN_PASSWORD); }
export async function login() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET fehlt');
  const body = `${Date.now()+1000*60*60*12}.${randomBytes(18).toString('base64url')}`;
  (await cookies()).set(name, `${body}.${signSessionBody(body,process.env.SESSION_SECRET)}`, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:60*60*12});
}
export async function logout() {
  const jar=await cookies(),value=jar.get(name)?.value,secret=process.env.SESSION_SECRET;
  // Commit revocation before clearing the browser cookie. A DB error must not
  // report a successful logout while a copied cookie still works.
  if(value&&secret&&secret.length>=32&&validSessionSignature(value,secret))revokeSession(db(),secret,value,Date.now());
  jar.delete(name);
}
export async function authorized() {
  const value=await sessionValue();
  if(!sessionSignatureValid(value))return false;
  return sessionAuthorized(db(),value);
}
/** Capture the credential after asynchronous request parsing. Do not log it. */
export async function sessionValue() { return (await cookies()).get(name)?.value || ''; }
export function sessionSignatureValid(value:string) {
  return sessionCookieValid(value,process.env.SESSION_SECRET);
}
/** Recheck inside the same serialized SQLite transaction as a sensitive mutation. */
export function sessionAuthorized(database:Database.Database,value:string) {
  const secret=process.env.SESSION_SECRET;
  if(!secret||!sessionSignatureValid(value))return false;
  return !sessionRevoked(database,secret,value);
}
/** For internal OIDC binding only; caller must hold the same SQLite write transaction as logout. */
export function sessionBindingProof(database:Database.Database,value:string):{sessionHash:string;expiresAt:number}|null {
  return verifiedSessionBindingProof(database,value,process.env.SESSION_SECRET);
}
export async function sameOrigin(req: Request) {
  const origin=req.headers.get('origin'); const h=await headers();
  return sameOriginPolicy(origin,h.get('host'),h.get('x-forwarded-host'),process.env.VIDEOMAKER_PUBLIC_ORIGIN);
}
