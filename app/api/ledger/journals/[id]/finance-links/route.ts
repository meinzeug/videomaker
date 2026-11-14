import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import db from '@/lib/db';
import {attachLedgerFinance,listLedgerFinanceLinks} from '@/lib/ug-ledger-finance-links';
import {NextResponse} from 'next/server';
import {ensureAllLedgerFinanceLinks} from '../../../_finance-links';
import {ledgerError,noStore,readLedgerJson} from '../../../_shared';
export const dynamic='force-dynamic';export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,{params}:Context){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const {id}=await params,database=db();ensureAllLedgerFinanceLinks(database);return NextResponse.json({links:listLedgerFinanceLinks(database,id)},{headers:noStore});}catch(error){return ledgerError(error);}
}
export async function POST(req:Request,{params}:Context){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id}=await params,data=await readLedgerJson(req),credential=await sessionValue(),database=db();ensureAllLedgerFinanceLinks(database);
  const result=database.transaction(()=>sessionAuthorized(database,credential)?attachLedgerFinance(database,id,data,new Date().toISOString()):null).immediate();
  if(!result)return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
  return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}catch(error){return ledgerError(error);}
}
