import {authorized,sameOrigin} from '@/lib/auth';
import {startUpdate,updateStatus,updateEnabled,updateDisabledMessage,UpdateBusy} from '@/lib/haben-update';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 if(!updateEnabled())return NextResponse.json({state:'disabled',message:updateDisabledMessage},{headers});
 try{return NextResponse.json(await updateStatus(),{headers});}
 catch{return NextResponse.json({error:'Update-Status ist nicht verfügbar.'},{status:503,headers});}
}
export async function POST(req:Request){
 if(!await sameOrigin(req))return NextResponse.json({error:'Ungültige Anfrage.'},{status:403,headers});
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 if(!updateEnabled())return NextResponse.json({error:updateDisabledMessage},{status:503,headers});
 try{await startUpdate(authorized);return NextResponse.json({ok:true},{status:202,headers});}
 catch(error){return NextResponse.json({error:error instanceof UpdateBusy?'Eine Vorbereitung läuft bereits oder wurde unterbrochen.':'Vorbereitung konnte nicht gestartet werden. Bitte Serverkonfiguration und Speicherplatz prüfen.'},{status:error instanceof UpdateBusy?409:503,headers});}
}
