import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,receiveCameraHeartbeat} from '@/lib/camera-remote-store';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraError,cameraJson,cameraNotFound,cameraOwner,cameraRemoteDisabled,noStore} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const report=parseCameraHeartbeat(await cameraJson(req)),owner=await cameraOwner();const database=db();ensureCameraRemoteSchema(database);return NextResponse.json({commands:receiveCameraHeartbeat(database,report,cameraRemoteClock(),owner)},{headers:noStore});}catch(error){return cameraError(error);}
}
