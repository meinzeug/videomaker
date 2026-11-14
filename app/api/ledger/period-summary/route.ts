import {authorized} from '@/lib/auth';
import db from '@/lib/db';
import {ensureUgLedgerSchema} from '@/lib/ug-ledger';
import {ledgerPeriodSummary,LedgerPeriodTooLarge} from '@/lib/ug-ledger-period';
import {ledgerError,noStore} from '../_shared';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';export const runtime='nodejs';
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const query=new URL(req.url).searchParams;
 if([...query.keys()].some(key=>key!=='from'&&key!=='to')||query.getAll('from').length!==1||query.getAll('to').length!==1)return NextResponse.json({error:'Bitte genau einen Zeitraum wählen.'},{status:400,headers:noStore});
 try{const database=db();ensureUgLedgerSchema(database);const summary=ledgerPeriodSummary(database,query.get('from'),query.get('to'));return NextResponse.json({...summary,generatedAt:new Date().toISOString()},{headers:noStore});}
 catch(error){if(error instanceof LedgerPeriodTooLarge)return NextResponse.json({error:error.message},{status:413,headers:noStore});return ledgerError(error);}
}
