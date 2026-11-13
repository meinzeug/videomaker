import {authorized,sameOrigin} from '@/lib/auth';
import {parseChannelIds} from '@/lib/channels';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,{params}:Context){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id}=await params;const database=db();
 if(!database.prepare('SELECT 1 FROM projects WHERE id=?').get(id))return NextResponse.json({error:'Skript nicht gefunden.'},{status:404});
 return NextResponse.json({channelIds:(database.prepare('SELECT channel_id FROM project_channels WHERE project_id=?').all(id) as {channel_id:string}[]).map(row=>row.channel_id)},{headers:{'Cache-Control':'no-store'}});
}
export async function PUT(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;let ids:string[];
 try{ids=parseChannelIds((await req.json()).channelIds);}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültige Auswahl.'},{status:400});}
 const database=db();
 const result=database.transaction(()=>{
  if(!database.prepare('SELECT 1 FROM projects WHERE id=?').get(id))return 'project';
  const exists=database.prepare('SELECT 1 FROM channels WHERE id=?');
  if(ids.some(channelId=>!exists.get(channelId)))return 'channel';
  database.prepare('DELETE FROM project_channels WHERE project_id=?').run(id);
  const insert=database.prepare('INSERT INTO project_channels(project_id,channel_id) VALUES(?,?)');
  ids.forEach(channelId=>insert.run(id,channelId));return 'ok';
 })();
 if(result!=='ok')return NextResponse.json({error:result==='project'?'Skript nicht gefunden.':'Kanal nicht gefunden.'},{status:404});
 return NextResponse.json({channelIds:ids});
}
