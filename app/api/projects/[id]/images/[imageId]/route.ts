import { authorized } from '@/lib/auth';
import db from '@/lib/db';
import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{id:string;imageId:string}>}) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id,imageId}=await params;
 const image=db().prepare("SELECT data,mime,kind,orientation,position FROM project_images WHERE project_id=? AND id=? AND status='ready'").get(id,imageId) as {data:Buffer;mime:string;kind:string;orientation:string;position:number}|undefined;
 if(!image?.data)return NextResponse.json({error:'Bild nicht gefunden'},{status:404});
 const download=new URL(req.url).searchParams.has('download');
 const format=image.orientation==='portrait'?'tiktok':'youtube';
 const name=image.kind==='thumbnail'?`kontrakurs-thumbnail-${format}.jpg`:`kontrakurs-einblendung-${image.position}-${format}.jpg`;
 return new Response(new Uint8Array(image.data),{headers:{'Content-Type':image.mime,'Content-Length':String(image.data.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${download?'attachment':'inline'}; filename="${name}"`}});
}
