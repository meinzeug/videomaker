import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {ensureUgLedgerSchema,ledgerBalances} from '@/lib/ug-ledger';
import {ledgerError,noStore} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const database=db();ensureUgLedgerSchema(database);return NextResponse.json({balances:ledgerBalances(database)},{headers:noStore});}catch(error){return ledgerError(error);}
}
