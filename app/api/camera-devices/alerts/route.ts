import {sessionSignatureValid,sessionValue} from '@/lib/auth';
import {readCameraLateAlerts} from '@/lib/camera-alerts-readonly';
import {cameraNotFound,cameraRemoteDisabled,noStore} from '../_shared';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 const credential=await sessionValue(),secret=process.env.SESSION_SECRET;
 if(!secret||!sessionSignatureValid(credential))return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const values=new URL(req.url).searchParams.getAll('before');
 const before=values.length>1||(values.length===1&&(!/^[1-9]\d{0,15}$/.test(values[0])||!Number.isSafeInteger(Number(values[0]))))?'invalid':values.length?Number(values[0]):null;
 try{
  const result=readCameraLateAlerts(process.env.DATA_DIR||'./data',credential,secret,before,sessionSignatureValid);
  if(result.kind==='unauthorized')return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
  if(result.kind==='invalid')return NextResponse.json({error:'Ungültige Seitenauswahl.'},{status:400,headers:noStore});
  return NextResponse.json(result.value,{headers:noStore});
 }catch{return NextResponse.json({error:'Kamerameldungen sind derzeit nicht verfügbar.'},{status:503,headers:noStore});}
}
