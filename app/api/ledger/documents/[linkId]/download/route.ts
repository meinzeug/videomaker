import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {readLinkedLedgerDocument} from '@/lib/ug-ledger-documents';
import {NextResponse} from 'next/server';
import {ensureAllLedgerDocuments} from '../../../_documents';
import {ledgerError,noStore} from '../../../_shared';
export const dynamic='force-dynamic';
export const runtime='nodejs';
function disposition(name:string){const fallback=name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'beleg';const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;}
export async function GET(_req:Request,{params}:{params:Promise<{linkId:string}>}){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const {linkId}=await params;const database=db();ensureAllLedgerDocuments(database);const {document,data}=readLinkedLedgerDocument(database,linkId);return new Response(new Uint8Array(data).buffer,{headers:{...noStore,'Content-Type':'application/octet-stream','Content-Length':String(document.size),'Content-Disposition':disposition(document.originalName),'Content-Security-Policy':"default-src 'none'; sandbox",'X-Finance-SHA256':document.sha256}});}catch(error){return ledgerError(error);}
}
