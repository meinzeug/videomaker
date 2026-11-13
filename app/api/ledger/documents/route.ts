import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {listLedgerDocumentOptions} from '@/lib/ug-ledger-documents';
import {NextResponse} from 'next/server';
import {ensureAllLedgerDocuments} from '../_documents';
import {ledgerError,noStore} from '../_shared';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const value=new URL(req.url).searchParams.get('before');
 if(value!==null&&(!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value))))return NextResponse.json({error:'Ungültige Seitenposition.'},{status:400,headers:noStore});
 try{const database=db();ensureAllLedgerDocuments(database);return NextResponse.json(listLedgerDocumentOptions(database,value===null?null:Number(value)),{headers:noStore});}catch(error){return ledgerError(error);}
}
