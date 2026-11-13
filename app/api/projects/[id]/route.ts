import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { NextResponse } from 'next/server';
export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}) {if(!await authorized() || !await sameOrigin(req)) return NextResponse.json({error:'Nicht erlaubt'},{status:403}); const {id}=await params; db().transaction(()=>{db().prepare('DELETE FROM project_images WHERE project_id=?').run(id);db().prepare('DELETE FROM image_jobs WHERE project_id=?').run(id);db().prepare('DELETE FROM projects WHERE id=?').run(id);})(); return NextResponse.json({ok:true});}
