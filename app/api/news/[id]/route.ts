import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { parseManualPackage } from '@/lib/manual';
import { NextResponse } from 'next/server';
type Context={params:Promise<{id:string}>};
export async function PATCH(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;let item;
 try{item=parseManualPackage(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiges News-Paket.'},{status:400});}
 const result=db().prepare('UPDATE news_packages SET title=?,angle=?,sources=? WHERE id=?').run(item.title,item.angle,JSON.stringify(item.sources),id);
 if(!result.changes)return NextResponse.json({error:'News-Paket nicht gefunden.'},{status:404});
 const row=db().prepare('SELECT created_at FROM news_packages WHERE id=?').get(id) as {created_at:string};
 return NextResponse.json({...item,id,created_at:row.created_at});
}
export async function DELETE(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;const result=db().prepare('DELETE FROM news_packages WHERE id=?').run(id);
 return result.changes?NextResponse.json({ok:true}):NextResponse.json({error:'News-Paket nicht gefunden.'},{status:404});
}
