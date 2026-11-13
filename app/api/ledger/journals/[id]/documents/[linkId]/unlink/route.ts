import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {unlinkLedgerDocument} from '@/lib/ug-ledger-documents';
import {NextResponse} from 'next/server';
import {ensureAllLedgerDocuments} from '../../../../../_documents';
import {ledgerError,noStore,readLedgerJson} from '../../../../../_shared';
export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{id:string;linkId:string}>};
export async function POST(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id,linkId}=await params;const data=await readLedgerJson(req);const database=db();ensureAllLedgerDocuments(database);const result=unlinkLedgerDocument(database,id,linkId,data,new Date().toISOString());return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}catch(error){return ledgerError(error);}
}
