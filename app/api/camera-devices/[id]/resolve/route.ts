import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureCameraRemoteSchema} from '@/lib/camera-remote-store';
import {CameraProjectClaimError,resolveCameraFailure} from '@/lib/camera-project-claims';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraCredential,cameraError,cameraJson,cameraNotFound,cameraRemoteDisabled,cameraTransaction,noStore} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{
  const {id}=await params;const body=await cameraJson(req) as Record<string,unknown>;
  if(!body||typeof body.recordingId!=='string'||typeof body.projectId!=='string'||body.confirm!=='retain-local-file')return NextResponse.json({error:'Bitte die Auflösung ausdrücklich bestätigen.'},{status:400,headers:noStore});
  const credential=await cameraCredential(),database=db();ensureCameraRemoteSchema(database);
  const result=cameraTransaction(database,credential,owner=>resolveCameraFailure(database,id.toLowerCase(),(body.recordingId as string).toLowerCase(),(body.projectId as string).toLowerCase(),owner,cameraRemoteClock()));
  return NextResponse.json(result,{headers:noStore});
 }catch(error){if(error instanceof CameraProjectClaimError)return NextResponse.json({error:error.message},{status:409,headers:noStore});return cameraError(error);}
}
