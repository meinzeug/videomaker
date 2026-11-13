import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema,listCameraDevices} from '@/lib/camera-remote-store';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraError,cameraNotFound,cameraRemoteDisabled,noStore} from './_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const database=db();ensureCameraRemoteSchema(database);return NextResponse.json(listCameraDevices(database,cameraRemoteClock()),{headers:noStore});}catch(error){return cameraError(error);}
}
