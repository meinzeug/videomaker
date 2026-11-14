import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraCredential} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError,previewTransaction} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function GET(){
 if(disabled())return notFound();
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const credential=await cameraCredential(),database=db();return NextResponse.json(previewTransaction(database,credential,owner=>cameraPreviewStore().availableDevices(cameraRemoteClock(),owner)),{headers:noStore});}catch(error){return previewError(error);}
}
