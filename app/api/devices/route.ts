import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const devices=db().prepare('SELECT id,name,role,status,last_seen,speed,font_size as fontSize FROM live_devices WHERE last_seen>? ORDER BY name').all(Date.now()-10000);
 return NextResponse.json({devices},{headers:{'Cache-Control':'no-store'}});
}
