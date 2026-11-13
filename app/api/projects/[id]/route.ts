import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { parseManualScript } from '@/lib/manual';
import { recordingPath, type Recording } from '@/lib/recordings';
import { existsSync, unlinkSync } from 'node:fs';
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
  const recordings=db().prepare('SELECT id,mime FROM project_recordings WHERE project_id=?').all(id) as Pick<Recording,'id'|'mime'>[];
  for(const item of recordings){const file=recordingPath(item.id,item.mime);if(existsSync(file))unlinkSync(file);}
  db().transaction(()=>{
   db().prepare('DELETE FROM project_recordings WHERE project_id=?').run(id);
   db().prepare('DELETE FROM project_images WHERE project_id=?').run(id);
   db().prepare('DELETE FROM image_jobs WHERE project_id=?').run(id);
   db().prepare('DELETE FROM projects WHERE id=?').run(id);
  })();
  return NextResponse.json({ok:true});
 } catch(error) {console.error('Skript konnte nicht gelöscht werden:',error);return NextResponse.json({error:'Skript und Aufnahmen konnten nicht gelöscht werden.'},{status:500});}
}
