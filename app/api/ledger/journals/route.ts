import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {ensureUgLedgerSchema,listLedgerJournals,postLedgerJournal} from '@/lib/ug-ledger';
import {ledgerError,noStore,readLedgerJson} from '../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(req:Request){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:noStore});
 const value=new URL(req.url).searchParams.get('before');
 if(value!==null&&(!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value))))return NextResponse.json({error:'Ungültige Seitenposition.'},{status:400,headers:noStore});
 try{const database=db();ensureUgLedgerSchema(database);return NextResponse.json(listLedgerJournals(database,value===null?null:Number(value)),{headers:noStore});}catch(error){return ledgerError(error);}
}
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const data=await readLedgerJson(req);const database=db();ensureUgLedgerSchema(database);const result=postLedgerJournal(database,data,new Date().toISOString());return NextResponse.json(result,{status:result.created?201:200,headers:noStore});}catch(error){return ledgerError(error);}
}
