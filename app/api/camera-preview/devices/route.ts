import {authorized} from '@/lib/auth';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraOwner} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function GET(){
 if(disabled())return notFound();
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{return NextResponse.json(cameraPreviewStore().availableDevices(cameraRemoteClock(),await cameraOwner()),{headers:noStore});}catch(error){return previewError(error);}
}
