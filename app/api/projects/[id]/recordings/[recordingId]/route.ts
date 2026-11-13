import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { isRecordingId, parseRange, recordingPath, type Recording } from '@/lib/recordings';
import { createReadStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{id:string;recordingId:string}>};

export async function GET(req:Request,{params}:Context) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id,recordingId}=await params;
 const item=isRecordingId(recordingId)?db().prepare('SELECT * FROM project_recordings WHERE project_id=? AND id=?').get(id,recordingId) as Recording|undefined:undefined;
 if(!item)return NextResponse.json({error:'Aufnahme nicht gefunden'},{status:404});
 const file=recordingPath(item.id,item.mime);
 let size:number;try{size=statSync(file).size;}catch{return NextResponse.json({error:'Aufnahmedatei nicht gefunden'},{status:404});}
 const headers:Record<string,string>={'Content-Type':item.mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${new URL(req.url).searchParams.has('download')?'attachment':'inline'}; filename="kontrakurs-aufnahme-${item.created_at.slice(0,19).replace(/[:T]/g,'-')}-${item.id.slice(0,8)}.${item.mime==='video/mp4'?'mp4':'webm'}"`};
 let start=0,end=size-1,status=200;
 const range=req.headers.get('range');
 if(range){
  const parsed=parseRange(range,size);
  if(!parsed)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
  ({start,end}=parsed);
  status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 }
 headers['Content-Length']=String(end-start+1);
 const stream=Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>;
 return new Response(stream,{status,headers});
}

export async function DELETE(req:Request,{params}:Context) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id,recordingId}=await params;
 if(!isRecordingId(recordingId))return NextResponse.json({error:'Aufnahme nicht gefunden'},{status:404});
 const item=db().prepare('SELECT * FROM project_recordings WHERE project_id=? AND id=?').get(id,recordingId) as Recording|undefined;
 if(!item)return NextResponse.json({error:'Aufnahme nicht gefunden'},{status:404});
 try{const file=recordingPath(item.id,item.mime);if(existsSync(file))unlinkSync(file);db().prepare('DELETE FROM project_recordings WHERE id=? AND project_id=?').run(recordingId,id);}
 catch{return NextResponse.json({error:'Aufnahme konnte nicht gelöscht werden.'},{status:500});}
 return NextResponse.json({ok:true});
}
