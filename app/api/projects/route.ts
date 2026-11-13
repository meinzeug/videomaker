import { authorized } from '@/lib/auth';
import db from '@/lib/db';
import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export async function GET() { if(!await authorized()) return NextResponse.json({error:'Nicht angemeldet'},{status:401}); const rows=db().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Array<{sources:string,content:string}>; return NextResponse.json(rows.map(p=>({...p,sources:JSON.parse(p.sources),content:JSON.parse(p.content)}))); }
