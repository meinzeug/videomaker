import {authorized,sameOrigin} from '@/lib/auth';
import {parseChannel} from '@/lib/channels';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
const columns='id,name,platform,handle,dramaturgy,instructions,created_at';
export async function GET(_req:Request,{params}:Context){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id}=await params;
 const channel=db().prepare(`SELECT ${columns} FROM channels WHERE id=?`).get(id);
 return channel?NextResponse.json(channel,{headers:{'Cache-Control':'no-store'}}):NextResponse.json({error:'Kanal nicht gefunden.'},{status:404});
}
/** Fields omitted from the body keep their stored value. */
export async function PUT(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;const database=db();
 let item;try{item=parseChannel(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiger Kanal.'},{status:400});}
 const info=database.prepare('UPDATE channels SET name=@name,platform=@platform,handle=@handle,dramaturgy=COALESCE(@dramaturgy,dramaturgy),instructions=COALESCE(@instructions,instructions) WHERE id=@id').run({id,name:item.name,platform:item.platform,handle:item.handle,dramaturgy:item.dramaturgy??null,instructions:item.instructions??null});
 if(!info.changes)return NextResponse.json({error:'Kanal nicht gefunden.'},{status:404});
 return NextResponse.json(database.prepare(`SELECT ${columns} FROM channels WHERE id=?`).get(id));
}
export async function DELETE(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;const database=db();
 const removed=database.transaction(()=>{
  const info=database.prepare('DELETE FROM channels WHERE id=?').run(id);
  if(!info.changes)return false;
  database.prepare('DELETE FROM project_channels WHERE channel_id=?').run(id);
  database.prepare("DELETE FROM chat_messages WHERE ref_id=? AND kind IN ('channel_dramaturgy','channel_instructions')").run(id);
  return true;
 }).immediate();
 return removed?NextResponse.json({ok:true}):NextResponse.json({error:'Kanal nicht gefunden.'},{status:404});
}
