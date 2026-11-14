import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import {readBoundedRequestBody} from '@/lib/bounded-request-body';
import {parseHeartbeat} from '@/lib/live-devices';
import {processDeviceHeartbeat} from '@/lib/live-device-queue';
import db from '@/lib/db';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const session=await sessionValue();
 let item;try{if(!req.body)throw new Error('Ungültige Meldung.');item=parseHeartbeat(JSON.parse((await readBoundedRequestBody(req.body,8192,10000)).toString('utf8')));}catch{return NextResponse.json({error:'Ungültige Meldung.'},{status:400});}
 const now=Date.now(),database=db();
 const commands=processDeviceHeartbeat(database,item,now,()=>sessionAuthorized(database,session));
 if(commands===null)return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 return NextResponse.json({commands},{headers:{'Cache-Control':'no-store'}});
}
