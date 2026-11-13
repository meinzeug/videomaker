import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {isFinanceId} from '@/lib/finance';
import {ensureFinanceSchema,FinanceNotFound} from '@/lib/finance-store';
import {ensureFinanceDocumentsSchema,FinanceDocumentCorrupt,readFinanceDocument} from '@/lib/finance-documents';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{entryId:string;documentId:string}>};
const noStore={'Cache-Control':'private, no-store'};
function disposition(name:string){
 const fallback=name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'beleg';
 const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
 return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export async function GET(_req:Request,{params}:Context){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const {entryId,documentId}=await params;
 if(!isFinanceId(entryId)||!isFinanceId(documentId))return NextResponse.json({error:'Beleg nicht gefunden.'},{status:404,headers:noStore});
 try{
  const database=db();ensureFinanceSchema(database);ensureFinanceDocumentsSchema(database);
  const {document,data}=readFinanceDocument(database,entryId,documentId);
  return new Response(new Uint8Array(data).buffer,{headers:{...noStore,'Content-Type':'application/octet-stream','Content-Length':String(document.size),'Content-Disposition':disposition(document.originalName),'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Finance-SHA256':document.sha256}});
 }catch(error){
  if(error instanceof FinanceNotFound)return NextResponse.json({error:error.message},{status:404,headers:noStore});
  if(error instanceof FinanceDocumentCorrupt)console.error('Finanzbeleg konnte die Integritätsprüfung nicht bestehen.');else console.error('Finanzbeleg konnte nicht gelesen werden.');
  return NextResponse.json({error:'Beleg konnte nicht geprüft oder geladen werden.'},{status:500,headers:noStore});
 }
}
