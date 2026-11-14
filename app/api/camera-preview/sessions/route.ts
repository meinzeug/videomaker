import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema} from '@/lib/camera-remote-store';
import {ensureCameraPairingSchema,isCameraPaired} from '@/lib/camera-device-pairing';
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
  const body=await previewJson(req) as {deviceId?:unknown},owner=await cameraOwner(),database=db(),clock=cameraRemoteClock();
  ensureCameraRemoteSchema(database);ensureCameraPairingSchema(database);
  const deviceId=typeof body?.deviceId==='string'?body.deviceId:'';
  const row=database.prepare('SELECT runtime_id AS runtimeId,updated_at AS wall,updated_tick AS tick FROM camera_remote_devices WHERE id=?').get(deviceId) as {runtimeId:string;wall:number;tick:number}|undefined;
  const available=!!row&&isCameraPaired(database,deviceId)&&row.runtimeId===clock.runtimeId&&row.wall<=clock.wall&&row.tick<=clock.tick&&row.wall>clock.wall-10000&&row.tick>clock.tick-10000;
  const result=cameraPreviewStore().create(body,owner,clock,available);
  return NextResponse.json(result,{status:result.created?201:200,headers:noStore});
 }catch(error){return previewError(error);}
}
