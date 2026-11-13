import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { parseManualPackage } from '@/lib/manual';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 let item;try{item=parseManualPackage(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiges News-Paket.'},{status:400});}
 const result={...item,id:randomUUID(),created_at:new Date().toISOString()};
 db().prepare('INSERT INTO news_packages(id,created_at,title,angle,sources) VALUES(?,?,?,?,?)').run(result.id,result.created_at,result.title,result.angle,JSON.stringify(result.sources));
 return NextResponse.json(result,{status:201});
}
