import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {isFinanceId,MAX_FINANCE_DOCUMENT_BYTES,validFinanceDocumentName} from '@/lib/finance';
import {ensureFinanceSchema,FinanceConflict,FinanceNotFound} from '@/lib/finance-store';
import {ensureFinanceDocumentsSchema,FinanceDocumentCorrupt,FinanceDocumentLimit,listFinanceDocuments,storeFinanceDocument} from '@/lib/finance-documents';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{entryId:string}>};
declare global {var __financeUploadsInFlight:number|undefined;}
class UploadError extends Error {constructor(message:string,public status:number){super(message);}}
const noStore={'Cache-Control':'private, no-store'};

async function readUpload(req:Request,expected:number|null):Promise<Buffer>{
 if(!req.body)throw new UploadError('Datei fehlt.',400);
 const reader=req.body.getReader();const chunks:Buffer[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},120000);
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(expired)throw new UploadError('Zeitlimit beim Hochladen überschritten.',408);
   if(done)break;
   size+=value.byteLength;
   if(size>MAX_FINANCE_DOCUMENT_BYTES){await reader.cancel();throw new UploadError('Die Datei ist größer als 10 MiB.',413);}
   // Retain an independent copy: a streaming source may reuse its backing buffers.
   chunks.push(Buffer.from(value));
  }
  if(expired)throw new UploadError('Zeitlimit beim Hochladen überschritten.',408);
  if(!size||(expected!==null&&size!==expected))throw new UploadError('Datei wurde nicht vollständig übertragen.',400);
  return Buffer.concat(chunks,size);
 }finally{clearTimeout(timer);reader.releaseLock();}
}
function errorResponse(error:unknown){
 if(error instanceof UploadError)return NextResponse.json({error:error.message},{status:error.status,headers:noStore});
 if(error instanceof FinanceNotFound)return NextResponse.json({error:error.message},{status:404,headers:noStore});
 if(error instanceof FinanceConflict)return NextResponse.json({error:error.message},{status:409,headers:noStore});
 if(error instanceof FinanceDocumentCorrupt){console.error('Finanzbeleg konnte die Integritätsprüfung nicht bestehen.');return NextResponse.json({error:'Der vorhandene Beleg hat die Integritätsprüfung nicht bestanden. Er wurde nicht überschrieben.'},{status:409,headers:noStore});}
 if(error instanceof FinanceDocumentLimit)return NextResponse.json({error:error.message},{status:413,headers:noStore});
 console.error('Finanzbeleg konnte nicht verarbeitet werden.');return NextResponse.json({error:'Beleg konnte nicht verarbeitet werden.'},{status:500,headers:noStore});
}
export async function GET(_req:Request,{params}:Context){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const {entryId}=await params;
 if(!isFinanceId(entryId))return NextResponse.json({error:'Finanzvorgang nicht gefunden.'},{status:404,headers:noStore});
 try{const database=db();ensureFinanceSchema(database);ensureFinanceDocumentsSchema(database);return NextResponse.json({documents:listFinanceDocuments(database,entryId)},{headers:noStore});}catch(error){return errorResponse(error);}
}
export async function POST(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 const {entryId}=await params;const id=req.headers.get('x-finance-document-id');const encodedName=req.headers.get('x-finance-filename');
 if(!isFinanceId(entryId)||!isFinanceId(id)||!encodedName||encodedName.length>2048)return NextResponse.json({error:'Ungültige Belegdaten.'},{status:400,headers:noStore});
 let originalName:string;try{originalName=decodeURIComponent(encodedName);}catch{return NextResponse.json({error:'Ungültiger Dateiname.'},{status:400,headers:noStore});}
 if(!validFinanceDocumentName(originalName))return NextResponse.json({error:'Ungültiger Dateiname.'},{status:400,headers:noStore});
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')return NextResponse.json({error:'Ungültiger Dateiupload.'},{status:400,headers:noStore});
 const header=req.headers.get('content-length');let expected:number|null=null;
 if(header!==null){if(!/^\d+$/.test(header)||!Number.isSafeInteger(Number(header)))return NextResponse.json({error:'Ungültige Dateigröße.'},{status:400,headers:noStore});expected=Number(header);if(expected>MAX_FINANCE_DOCUMENT_BYTES)return NextResponse.json({error:'Die Datei ist größer als 10 MiB.'},{status:413,headers:noStore});}
 try{const database=db();ensureFinanceSchema(database);ensureFinanceDocumentsSchema(database);listFinanceDocuments(database,entryId);}catch(error){return errorResponse(error);}
 if((globalThis.__financeUploadsInFlight||0)>=2)return NextResponse.json({error:'Es werden bereits Belege hochgeladen. Bitte später erneut versuchen.'},{status:429,headers:{...noStore,'Retry-After':'10'}});
 globalThis.__financeUploadsInFlight=(globalThis.__financeUploadsInFlight||0)+1;
 try{
  const data=await readUpload(req,expected);const database=db();const result=storeFinanceDocument(database,{id,entryId,originalName,data},new Date().toISOString());
  return NextResponse.json(result,{status:result.created?201:200,headers:noStore});
 }catch(error){return errorResponse(error);}finally{globalThis.__financeUploadsInFlight=Math.max(0,(globalThis.__financeUploadsInFlight||1)-1);}
}
