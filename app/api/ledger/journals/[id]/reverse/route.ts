import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureUgLedgerSchema,reverseLedgerJournal} from '@/lib/ug-ledger';
import {InvalidLedgerBody,ledgerError,noStore,readLedgerJson} from '../../../_shared';
import {NextResponse} from 'next/server';
export const runtime='nodejs';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{
  const data=await readLedgerJson(req);if(!data||typeof data!=='object'||Array.isArray(data))throw new InvalidLedgerBody('Ungültige Anfrage.');
  const {id}=await params;const database=db();ensureUgLedgerSchema(database);
  const result=reverseLedgerJournal(database,{...data,entryId:id},new Date().toISOString());
  return NextResponse.json(result,{status:result.created?201:200,headers:noStore});
 }catch(error){return ledgerError(error);}
}
