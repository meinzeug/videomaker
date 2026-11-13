import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { parseManualScript } from '@/lib/manual';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export async function GET() { if(!await authorized()) return NextResponse.json({error:'Nicht angemeldet'},{status:401}); const rows=db().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Array<{sources:string,content:string}>; return NextResponse.json(rows.map(p=>({...p,sources:JSON.parse(p.sources),content:JSON.parse(p.content)}))); }
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 let item;try{item=parseManualScript(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiges Skript.'},{status:400});}
 const project={id:randomUUID(),created_at:new Date().toISOString(),title:item.title,sources:item.sources,content:{titles:item.titles,thumbnail:item.thumbnail,broll:item.broll,script:item.script,image_mode:'descriptions'}};
 db().prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(project.id,project.created_at,project.title,JSON.stringify(project.sources),JSON.stringify(project.content));
 return NextResponse.json(project,{status:201});
}
