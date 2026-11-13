import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {createLedgerAccount,ensureUgLedgerSchema} from '@/lib/ug-ledger';
import {ledgerError,noStore,readLedgerJson} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 try{const database=db();ensureUgLedgerSchema(database);return NextResponse.json({accounts:database.prepare('SELECT id,code,name,kind,created_at AS createdAt FROM ug_ledger_accounts ORDER BY code,id').all()},{headers:noStore});}catch(error){return ledgerError(error);}
}
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const data=await readLedgerJson(req);const database=db();ensureUgLedgerSchema(database);const result=createLedgerAccount(database,data,new Date().toISOString());return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}catch(error){return ledgerError(error);}
}
