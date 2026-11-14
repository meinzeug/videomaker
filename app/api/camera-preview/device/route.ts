import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraPairingSchema,verifyCameraDeviceTicket} from '@/lib/camera-device-pairing';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraOwner} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError,previewJson} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function POST(req:Request){
 if(disabled())return notFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{
  const body=await previewJson(req) as {deviceId?:unknown},owner=await cameraOwner(),database=db(),clock=cameraRemoteClock(),ticket=req.headers.get('x-camera-device-ticket');
  ensureCameraPairingSchema(database);
  if(typeof body?.deviceId!=='string'||!ticket||!verifyCameraDeviceTicket(database,body.deviceId,ticket,owner,clock))return NextResponse.json({error:'Gerätenachweis ungültig oder abgelaufen.'},{status:403,headers:noStore});
  return NextResponse.json(cameraPreviewStore().deviceExchange(body.deviceId,body,clock),{headers:noStore});
 }catch(error){return previewError(error);}
}
