import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {parseFinanceSettings} from '@/lib/finance';
import {FinanceConflict} from '@/lib/finance-store';
import {createFinanceSettings,ensureFinanceSettingsSchema,listFinanceSettings} from '@/lib/finance-settings';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const noStore={'Cache-Control':'private, no-store'};
const maxBody=4096;
class BodyError extends Error{}
async function readJson(req:Request):Promise<unknown>{
 const length=req.headers.get('content-length');
 if(length&&(!/^\d+$/.test(length)||Number(length)>maxBody))throw new BodyError('Anfrage ist zu groß.');
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!req.body)throw new BodyError('Ungültige Anfrage.');
 const reader=req.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBody){await reader.cancel();throw new BodyError('Anfrage ist zu groß.');}chunks.push(Uint8Array.from(value));}}finally{reader.releaseLock();}
 try{const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new BodyError('Ungültige JSON-Anfrage.');}
}
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const value=new URL(req.url).searchParams.get('before');let before:number|null=null;
 if(value!==null){if(!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value)))return NextResponse.json({error:'Ungültige Seitenposition.'},{status:400,headers:noStore});before=Number(value);}
 try{const database=db();ensureFinanceSettingsSchema(database);return NextResponse.json(listFinanceSettings(database,before),{headers:noStore});}catch{console.error('Finanzkonfiguration konnte nicht geladen werden.');return NextResponse.json({error:'Konfiguration konnte nicht geladen werden.'},{status:500,headers:noStore});}
}
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 let item:ReturnType<typeof parseFinanceSettings>;
 try{item=parseFinanceSettings(await readJson(req));}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Ungültige Anfrage.'},{status:400,headers:noStore});}
 try{const database=db();ensureFinanceSettingsSchema(database);const result=createFinanceSettings(database,item,new Date().toISOString());return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}
 catch(error){if(error instanceof FinanceConflict)return NextResponse.json({error:error.message},{status:409,headers:noStore});console.error('Finanzkonfiguration konnte nicht gespeichert werden.');return NextResponse.json({error:'Konfiguration konnte nicht gespeichert werden.'},{status:500,headers:noStore});}
}
