import {sessionSignatureValid,sessionValue} from '@/lib/auth';
import {isUuid} from '@/lib/live-devices';
import {readOpenCameraClaims} from '@/lib/camera-claims-readonly';
import {cameraNotFound,cameraRemoteDisabled,noStore} from '../_shared';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 const credential=await sessionValue(),secret=process.env.SESSION_SECRET;
 if(!secret||!sessionSignatureValid(credential))return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const values=new URL(req.url).searchParams.getAll('projectId');
 try{
  // Never create a database or schema from this informational read. A single
  // read snapshot binds revocation and claim lookup; WAL updates remain visible.
  const projectId=values.length===1&&isUuid(values[0])?values[0].toLowerCase():null;
  const result=readOpenCameraClaims(process.env.DATA_DIR||'./data',credential,secret,projectId,sessionSignatureValid);
  if(result.kind==='unauthorized')return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
  if(result.kind==='invalid')return NextResponse.json({error:'Ungültiges Skript.'},{status:400,headers:noStore});
  return NextResponse.json(result.value,{headers:noStore});
 }catch{return NextResponse.json({error:'Offene Kameravorgänge sind derzeit nicht verfügbar.'},{status:503,headers:noStore});}
}
