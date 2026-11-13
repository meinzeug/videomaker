import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {parseFinanceDraft,parseFinanceReversal} from '@/lib/finance';
import {createFinanceEntry,ensureFinanceSchema,FinanceConflict,FinanceNotFound,listFinance,reverseFinanceEntry} from '@/lib/finance-store';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const MAX_BODY_BYTES=8192;
class InvalidBody extends Error {}
async function readJson(req:Request):Promise<unknown>{
 const length=req.headers.get('content-length');
 if(length && (!/^\d+$/.test(length)||Number(length)>MAX_BODY_BYTES))throw new InvalidBody('Anfrage ist zu groß.');
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!req.body)throw new InvalidBody('Ungültige Anfrage.');
 const reader=req.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{
  while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();throw new InvalidBody('Anfrage ist zu groß.');}chunks.push(Uint8Array.from(value));}
 } finally {reader.releaseLock();}
 try {const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new InvalidBody('Ungültige JSON-Anfrage.');}
}
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401});
 const value=new URL(req.url).searchParams.get('before');let before:number|null=null;
 if(value!==null){if(!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value)))return NextResponse.json({error:'Ungültige Seitenposition.'},{status:400});before=Number(value);}
 try{const database=db();ensureFinanceSchema(database);return NextResponse.json(listFinance(database,before),{headers:{'Cache-Control':'private, no-store'}});}
 catch{console.error('Finanzeinträge konnten nicht gelesen werden.');return NextResponse.json({error:'Finanzeinträge konnten nicht geladen werden.'},{status:500});}
}
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403});
 let body:unknown;
 try{body=await readJson(req);}catch(error){return NextResponse.json({error:error instanceof InvalidBody?error.message:'Ungültige Anfrage.'},{status:400});}
 if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'Ungültige Anfrage.'},{status:400});
 const action=(body as Record<string,unknown>).action;
 let item:ReturnType<typeof parseFinanceDraft>|ReturnType<typeof parseFinanceReversal>;
 try{
  if(action==='entry')item=parseFinanceDraft(body);
  else if(action==='reversal')item=parseFinanceReversal(body);
  else throw new Error('Unbekannte Aktion.');
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Ungültige Anfrage.'},{status:400});}
 try{
  const database=db();ensureFinanceSchema(database);const now=new Date().toISOString();
  const result=action==='entry'?createFinanceEntry(database,item as ReturnType<typeof parseFinanceDraft>,now):reverseFinanceEntry(database,item as ReturnType<typeof parseFinanceReversal>,now);
  return NextResponse.json(result,{status:result.created?201:200,headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof FinanceNotFound)return NextResponse.json({error:error.message},{status:404});
  if(error instanceof FinanceConflict)return NextResponse.json({error:error.message},{status:409});
  console.error('Finanzeintrag konnte nicht gespeichert werden.');return NextResponse.json({error:'Eintrag konnte nicht gespeichert werden.'},{status:500});
 }
}
