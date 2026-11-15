import {authorized,sameOrigin,sessionValue} from '@/lib/auth';
import {readBoundedRequestBody} from '@/lib/bounded-request-body';
import {beginStudioDeviceEnrollment} from '@/lib/studio-device-enrollment';
import db from '@/lib/db';
import {NextResponse} from 'next/server';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
// Deliberate hard gate; this incomplete route cannot be enabled by environment.
const STUDIO_DEVICE_ENROLLMENT_READY=false;
const bad=()=>NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers});
export async function POST(req:Request){
 if(!STUDIO_DEVICE_ENROLLMENT_READY)return NextResponse.json({error:'Nicht gefunden.'},{status:404,headers});
 if(!await authorized()||!await sameOrigin(req))return bad();
 if(req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'||!req.body)return bad();
 try{
  const raw=await readBoundedRequestBody(req.body,2048,10000);const body:unknown=JSON.parse(raw.toString('utf8'));
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='deviceId,publicKey')return bad();
  const data=body as Record<string,unknown>;
  if(typeof data.deviceId!=='string'||typeof data.publicKey!=='string'||!/^[-_A-Za-z0-9]+$/.test(data.publicKey)||data.publicKey.length>342)return bad();
  const bytes=Buffer.from(data.publicKey,'base64url');if(bytes.toString('base64url')!==data.publicKey)return bad();
  const result=beginStudioDeviceEnrollment(db(),await sessionValue(),{deviceId:data.deviceId,publicKey:bytes});
  return result?NextResponse.json(result,{headers}):bad();
 }catch{return NextResponse.json({error:'Geräteanmeldung nicht verfügbar.'},{status:503,headers});}
}
