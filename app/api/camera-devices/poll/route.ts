import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema,parseCameraHeartbeat,receiveCameraHeartbeat} from '@/lib/camera-remote-store';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {ensureCameraPairingSchema,isCameraPaired,verifyCameraDeviceTicket} from '@/lib/camera-device-pairing';
import {cameraError,cameraJson,cameraNotFound,cameraOwner,cameraRemoteDisabled,noStore} from '../_shared';
import {createHmac} from 'node:crypto';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{
  const report=parseCameraHeartbeat(await cameraJson(req)),owner=await cameraOwner();const database=db();
  ensureCameraRemoteSchema(database);ensureCameraPairingSchema(database);
  const commands=database.transaction(()=>{
   const paired=isCameraPaired(database,report.id),ticket=req.headers.get('x-camera-device-ticket');const clock=cameraRemoteClock();
   if(paired||ticket){
    if(!ticket||!verifyCameraDeviceTicket(database,report.id,ticket,owner,clock))return null;
    // The signing key proves identity; unlike the Studio cookie this identity
    // stays stable after login renewal. The ticket is checked on every poll.
    const stableOwner=createHmac('sha256',process.env.SESSION_SECRET!).update('camera-paired-device/v2\0').update(report.id).digest('hex');
    return receiveCameraHeartbeat(database,report,clock,stableOwner,undefined,true);
   }
   // Legacy, unpaired polling exists solely for explicitly opted-in local
   // protocol fixtures, never by default or in a production process.
   if(process.env.NODE_ENV==='production'||process.env.CAMERA_REMOTE_ALLOW_LEGACY_FIXTURE!=='1')return null;
   return receiveCameraHeartbeat(database,report,clock,owner);
  }).immediate();
  if(commands===null)return NextResponse.json({error:'Gerätenachweis ungültig oder abgelaufen.'},{status:403,headers:noStore});
  return NextResponse.json({commands},{headers:noStore});
 }catch(error){return cameraError(error);}
}
