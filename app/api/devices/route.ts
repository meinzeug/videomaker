import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const database=db(),now=Date.now();
 const rows=database.prepare('SELECT id,name,role,status,last_seen,speed,font_size as fontSize FROM live_devices WHERE last_seen>? ORDER BY name').all(now-10000) as Array<{id:string}>;
 const receipts=database.prepare('SELECT id FROM live_command_receipts WHERE device_id=? AND completed_at>? ORDER BY completed_at DESC,rowid DESC LIMIT 32');
 const devices=rows.map(device=>({...device,acknowledged:(receipts.all(device.id,now-60000) as {id:string}[]).map(item=>item.id)}));
 return NextResponse.json({devices},{headers:{'Cache-Control':'no-store'}});
}
