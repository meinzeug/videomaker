import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { isRecordingId, MAX_RECORDING_SIZE, recordingPath, recordingsDir, type Recording } from '@/lib/recordings';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};

export async function GET(_req:Request,{params}:Context) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id}=await params;
 if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return NextResponse.json({error:'Skript nicht gefunden'},{status:404});
 return NextResponse.json({recordings:db().prepare('SELECT id,created_at,mime,size FROM project_recordings WHERE project_id=? ORDER BY created_at DESC, id DESC').all(id)},{headers:{'Cache-Control':'no-store'}});
}

export async function POST(req:Request,{params}:Context) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;
 const recordingId=req.headers.get('x-recording-id') || '';
 const mime=(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
 const length=Number(req.headers.get('content-length') || 0);
 if(!isRecordingId(recordingId)||!['video/webm','video/mp4'].includes(mime)||!req.body||!Number.isSafeInteger(length)||length<0)
  return NextResponse.json({error:'Ungültige Aufnahme.'},{status:400});
 if(length>MAX_RECORDING_SIZE)return NextResponse.json({error:'Die Aufnahme ist größer als 1 GB.'},{status:413});
 if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return NextResponse.json({error:'Skript nicht gefunden'},{status:404});
 const existing=db().prepare('SELECT * FROM project_recordings WHERE id=?').get(recordingId) as Recording|undefined;
 if(existing)return existing.project_id===id?NextResponse.json({id:recordingId}):NextResponse.json({error:'Aufnahme-ID bereits vergeben.'},{status:409});
 let temporary='';
 try {
  await mkdir(recordingsDir(),{recursive:true,mode:0o700});
  temporary=path.join(recordingsDir(),`.upload-${randomUUID()}`);
  const file=await open(temporary,'wx',0o600);
  let size=0;
  try {
   const reader=req.body.getReader();
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RECORDING_SIZE){await reader.cancel();throw new Error('TOO_LARGE');}await file.writeFile(value);}
  } finally {await file.close();}
  if(!size || (length && size!==length))throw new Error('INCOMPLETE');
  const createdAt=new Date().toISOString();
  const result=db().transaction(()=>{
   if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return 'missing';
   const old=db().prepare('SELECT project_id FROM project_recordings WHERE id=?').get(recordingId) as {project_id:string}|undefined;
   if(old)return old.project_id===id?'exists':'conflict';
   renameSync(temporary,recordingPath(recordingId,mime));
   try {db().prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(recordingId,id,createdAt,mime,size);}
   catch(error){try{unlinkSync(recordingPath(recordingId,mime));}catch{}throw error;}
   return 'created';
  })();
  if(result==='missing')return NextResponse.json({error:'Skript wurde gelöscht.'},{status:404});
  if(result==='conflict')return NextResponse.json({error:'Aufnahme-ID bereits vergeben.'},{status:409});
  return NextResponse.json({id:recordingId},{status:result==='created'?201:200});
 } catch(error) {
  if(error instanceof Error && error.message==='TOO_LARGE')return NextResponse.json({error:'Die Aufnahme ist größer als 1 GB.'},{status:413});
  if(error instanceof Error && error.message==='INCOMPLETE')return NextResponse.json({error:'Die Aufnahme wurde nicht vollständig übertragen.'},{status:400});
  console.error('Aufnahme konnte nicht gespeichert werden:',error);
  return NextResponse.json({error:'Speichern fehlgeschlagen. Bitte Speicherplatz und Verbindung prüfen und erneut versuchen.'},{status:500});
 } finally {if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
}
