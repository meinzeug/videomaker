import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {listProductionQueue} from '@/lib/production-queue';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 const channel=new URL(req.url).searchParams.get('channel')||'';
 try {return NextResponse.json(listProductionQueue(db(),channel),{headers});}
 catch(error){if(error instanceof Error&&error.message==='Ungültiger Kanal.')return NextResponse.json({error:error.message},{status:400,headers});console.error('Produktionsübersicht konnte nicht geladen werden.');return NextResponse.json({error:'Produktionsübersicht konnte nicht geladen werden.'},{status:500,headers});}
}
