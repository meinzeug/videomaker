import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema,listCameraDevices} from '@/lib/camera-remote-store';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraCredential,cameraError,cameraNotFound,cameraRemoteDisabled,cameraTransaction,noStore} from './_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const credential=await cameraCredential(),database=db();ensureCameraRemoteSchema(database);const result=cameraTransaction(database,credential,()=>listCameraDevices(database,cameraRemoteClock()));return NextResponse.json(result,{headers:noStore});}catch(error){return cameraError(error);}
}
