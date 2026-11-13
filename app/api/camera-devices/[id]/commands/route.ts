import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema,parseCameraRequest,queueCameraRequest} from '@/lib/camera-remote-store';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraError,cameraJson,cameraNotFound,cameraRemoteDisabled,noStore} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id}=await params,command=parseCameraRequest(await cameraJson(req));const database=db();ensureCameraRemoteSchema(database);const result=queueCameraRequest(database,id,command,cameraRemoteClock());return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}catch(error){return cameraError(error);}
}
