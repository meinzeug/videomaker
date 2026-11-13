import {authorized,sameOrigin} from '@/lib/auth';
import {parseHeartbeat} from '@/lib/live-devices';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 let item;try{item=parseHeartbeat(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültige Meldung.'},{status:400});}
 const now=Date.now(),database=db();
 const commands=database.transaction(()=>{
  database.prepare('DELETE FROM live_commands WHERE expires_at<=?').run(now);
  database.prepare('DELETE FROM live_devices WHERE last_seen<?').run(now-300000);
  database.prepare('INSERT INTO live_devices(id,name,role,status,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,status=excluded.status,last_seen=excluded.last_seen').run(item.id,item.name,item.role,item.status,now);
  const ack=database.prepare('DELETE FROM live_commands WHERE id=? AND device_id=?');item.ack.forEach(id=>ack.run(id,item.id));
  return database.prepare('SELECT id,type,project_id as projectId,expires_at-? as remainingMs FROM live_commands WHERE device_id=? AND expires_at>? ORDER BY created_at,rowid LIMIT 1').all(now,item.id,now);
 })();
 return NextResponse.json({commands},{headers:{'Cache-Control':'no-store'}});
}
