import { authorized, sameOrigin } from '@/lib/auth';
import { imageStatus, startImages } from '@/lib/images';
import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,{params}:Context) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id}=await params; const status=imageStatus(id);
 return status?NextResponse.json(status,{headers:{'Cache-Control':'no-store'}}):NextResponse.json({error:'Skript nicht gefunden'},{status:404});
}
export async function POST(req:Request,{params}:Context) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;
 if(!startImages(id))return NextResponse.json({error:'Skript nicht gefunden'},{status:404});
 return NextResponse.json(imageStatus(id),{status:202});
}
