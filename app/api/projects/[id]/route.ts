import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { parseManualScript } from '@/lib/manual';
import { recordingPath, type Recording } from '@/lib/recordings';
import { CAMERA_PROJECT_CLAIMS_SCHEMA, assertCameraProjectDeletable, CameraProjectClaimError } from '@/lib/camera-project-claims';
import {PROJECT_RECORDING_DELETION_SCHEMA,queueProjectRecordingDeletions,drainProjectRecordingDeletions} from '@/lib/project-recording-deletions';
import { NextResponse } from 'next/server';

export async function PATCH(req:Request,{params}:{params:Promise<{id:string}>}) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;let item;
 try{item=parseManualScript(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiges Skript.'},{status:400});}
 const row=db().prepare('SELECT * FROM projects WHERE id=?').get(id) as {id:string;title:string;created_at:string;sources:string;content:string}|undefined;
 if(!row)return NextResponse.json({error:'Skript nicht gefunden.'},{status:404});
 const content=JSON.parse(row.content);
 content.titles=item.titles;content.script=item.script;content.thumbnail=item.thumbnail;content.broll=item.broll;
 db().prepare('UPDATE projects SET title=?,sources=?,content=? WHERE id=?').run(item.title,JSON.stringify(item.sources),JSON.stringify(content),id);
 return NextResponse.json({...row,title:item.title,sources:item.sources,content});
}

export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}) {
 if(!await authorized() || !await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;
 try {
  const database=db();database.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);database.exec(PROJECT_RECORDING_DELETION_SCHEMA);
  database.transaction(()=>{
   // Hold the write lock through the guard, durable cleanup jobs and DB delete.
   // Actual files stay untouched until this transaction has committed.
   assertCameraProjectDeletable(database,id);
   const recordings=database.prepare('SELECT id,mime FROM project_recordings WHERE project_id=?').all(id) as Pick<Recording,'id'|'mime'>[];
   queueProjectRecordingDeletions(database,recordings,recordingPath);
   database.prepare('DELETE FROM project_recordings WHERE project_id=?').run(id);
   database.prepare('DELETE FROM project_images WHERE project_id=?').run(id);
   database.prepare('DELETE FROM image_jobs WHERE project_id=?').run(id);
   database.prepare('DELETE FROM project_channels WHERE project_id=?').run(id);
   database.prepare('DELETE FROM projects WHERE id=?').run(id);
  }).immediate();
  try {if(drainProjectRecordingDeletions(database,recordingPath)>0)return NextResponse.json({ok:true,cleanupPending:true});}
  catch(error){console.error('Aufnahmebereinigung wird später erneut versucht:',error);return NextResponse.json({ok:true,cleanupPending:true});}
  return NextResponse.json({ok:true});
 } catch(error) {if(error instanceof CameraProjectClaimError)return NextResponse.json({error:error.message},{status:409});console.error('Skript konnte nicht gelöscht werden:',error);return NextResponse.json({error:'Skript und Aufnahmen konnten nicht gelöscht werden.'},{status:500});}
}
