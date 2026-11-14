import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {ensureUgLedgerSchema} from '@/lib/ug-ledger';
import {exportLedgerCsv,LedgerExportTooLarge} from '@/lib/ug-ledger-export';
import {ledgerError,noStore} from '../_shared';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{
  const database=db();ensureUgLedgerSchema(database);
  return new Response(exportLedgerCsv(database),{headers:{...noStore,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="buchungsjournal.csv"'}});
 }catch(error){
  if(error instanceof LedgerExportTooLarge)return NextResponse.json({error:error.message},{status:413,headers:noStore});
  return ledgerError(error);
 }
}
