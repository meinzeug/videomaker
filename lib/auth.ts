import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';

const name = 'kontrakurs_session';
function signature(value: string) { return createHmac('sha256', process.env.SESSION_SECRET || '').update(value).digest('base64url'); }
function safeEqual(a: string, b: string) { const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa,bb); }
export function passwordMatches(value: string) { return !!process.env.ADMIN_PASSWORD && safeEqual(value, process.env.ADMIN_PASSWORD); }
export async function login() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET fehlt');
  const body = `${Date.now()+1000*60*60*12}.${randomBytes(18).toString('base64url')}`;
  (await cookies()).set(name, `${body}.${signature(body)}`, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:60*60*12});
}
export async function logout() { (await cookies()).delete(name); }
export async function authorized() {
  const secret=process.env.SESSION_SECRET; if (!secret || secret.length < 32) return false;
  const value=(await cookies()).get(name)?.value || ''; const parts=value.split('.');
  return parts.length===3 && Number(parts[0])>Date.now() && safeEqual(parts[2], signature(`${parts[0]}.${parts[1]}`));
}
export async function sameOrigin(req: Request) {
  const origin=req.headers.get('origin'); const h=await headers();
  const host=h.get('x-forwarded-host') || h.get('host');
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
