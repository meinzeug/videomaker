import {authorized,sameOrigin} from '@/lib/auth';
import {parseChannel} from '@/lib/channels';
import db from '@/lib/db';
import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 return NextResponse.json({channels:db().prepare('SELECT id,name,platform,handle,created_at FROM channels ORDER BY name COLLATE NOCASE, id').all()},{headers:{'Cache-Control':'no-store'}});
}
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 try {const item=parseChannel(await req.json());const channel={id:randomUUID(),...item,created_at:new Date().toISOString()};db().prepare('INSERT INTO channels(id,name,platform,handle,created_at) VALUES(@id,@name,@platform,@handle,@created_at)').run(channel);return NextResponse.json(channel,{status:201});}
 catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiger Kanal.'},{status:400});}
}
