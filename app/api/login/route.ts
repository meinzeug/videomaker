import { login, passwordMatches, sameOrigin } from '@/lib/auth';
import { NextResponse } from 'next/server';
const attempts = new Map<string,{count:number,until:number}>();
export async function POST(req:Request) {
 if (!await sameOrigin(req)) return NextResponse.json({error:'Ungültige Anfrage.'},{status:403});
 const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'; const now=Date.now();
 const entry=attempts.get(ip); if(entry && entry.until>now && entry.count>=5) return NextResponse.json({error:'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.'},{status:429});
 const data=await req.json().catch(()=>({}));
 if(typeof data.password!=='string' || !passwordMatches(data.password)) {const record=entry && entry.until>now ? entry : {count:0,until:now+900000}; record.count++; attempts.set(ip,record); return NextResponse.json({error:'Passwort ist nicht korrekt.'},{status:401});}
 attempts.delete(ip); await login(); return NextResponse.json({ok:true});
}
