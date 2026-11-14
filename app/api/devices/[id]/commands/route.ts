import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import {readBoundedRequestBody} from '@/lib/bounded-request-body';
import {isUuid,parseCommand} from '@/lib/live-devices';
import db from '@/lib/db';
import {enqueueDeviceCommand} from '@/lib/live-device-queue';
import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const session=await sessionValue();
 const {id}=await params;if(!isUuid(id))return NextResponse.json({error:'Ungültiges Gerät.'},{status:400});
 let command;try{if(!req.body)throw new Error();command=parseCommand(JSON.parse((await readBoundedRequestBody(req.body,4096,10000)).toString('utf8')));}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiger Befehl.'},{status:400});}
 const now=Date.now(),database=db();
 const commandId=randomUUID();
 const result=enqueueDeviceCommand(database,id,command,now,()=>sessionAuthorized(database,session),commandId);
 if(result!=='ok')return NextResponse.json({error:result==='auth'?'Nicht angemeldet':result==='offline'?'Gerät ist nicht erreichbar.':result==='role'?'Befehl benötigt ein Anzeigegerät.':result==='project'?'Skript nicht gefunden.':result==='unsupported'?'Die App unterstützt diese Einstellung noch nicht.':'Gerät verarbeitet noch Befehle.'},{status:result==='auth'?401:result==='project'?404:409});
 return NextResponse.json({queued:true,commandId},{headers:{'Cache-Control':'no-store'}});
}
