import type Database from 'better-sqlite3';
import {LedgerValidationError,parseLedgerEntry,type AccountKind,type LedgerAccount} from './ug-ledger.ts';

export const MAX_PERIOD_ACCOUNTS=5_000;
export const MAX_PERIOD_JOURNALS=10_000;
export const MAX_PERIOD_LINES=50_000;
export class LedgerPeriodTooLarge extends Error {
 constructor(message='Der Zeitraum ist für eine vollständige Auswertung zu groß. Bitte einen kleineren Zeitraum wählen.'){super(message);}
}
export type PeriodAccount={account:LedgerAccount;debitCents:string;creditCents:string;netDebitCents:string};
export type LedgerPeriodSummary={from:string;to:string;journalCount:number;lineCount:number;accounts:PeriodAccount[];incomeCreditMinusDebitCents:string;expenseDebitMinusCreditCents:string;incomeLessExpenseCents:string};

function validDay(value:unknown):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new LedgerValidationError('Bitte zwei gültige Datumsangaben wählen.');
 const [year,month,day]=value.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));
 if(year<1900||year>9999||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new LedgerValidationError('Bitte zwei gültige Datumsangaben wählen.');
 return value;
}

/** Read-only movements in one consistent snapshot; this is not an annual close. */
export function ledgerPeriodSummary(database:Database.Database,start:unknown,end:unknown):LedgerPeriodSummary {
 const from=validDay(start),to=validDay(end);
 if(from>to)throw new LedgerValidationError('Das Anfangsdatum darf nicht nach dem Enddatum liegen.');
 return database.transaction(()=>{
  const accounts=database.prepare('SELECT id,code,name,kind,created_at AS createdAt FROM ug_ledger_accounts ORDER BY code,id LIMIT ?').all(MAX_PERIOD_ACCOUNTS+1) as LedgerAccount[];
  if(accounts.length>MAX_PERIOD_ACCOUNTS)throw new LedgerPeriodTooLarge('Der Kontenplan ist für eine vollständige Auswertung zu groß. Es wurde keine Auswertung erstellt.');
  const kinds=new Set<AccountKind>(['asset','liability','equity','income','expense']);
  if(accounts.some(account=>!kinds.has(account.kind)))throw new Error('Ungültige Kontoart im Journal.');
  const totals=new Map(accounts.map(account=>[account.id,{debit:0n,credit:0n}]));
  let journalCount=0,lineCount=0;
  const rows=database.prepare('SELECT id,occurred_on AS occurredOn,description,lines_json AS linesJson FROM ug_ledger_journals WHERE occurred_on>=? AND occurred_on<=? ORDER BY occurred_on,id LIMIT ?').iterate(from,to,MAX_PERIOD_JOURNALS+1) as Iterable<{id:string;occurredOn:string;description:string;linesJson:string}>;
  for(const row of rows){
   if(++journalCount>MAX_PERIOD_JOURNALS)throw new LedgerPeriodTooLarge();
   let entry:ReturnType<typeof parseLedgerEntry>;
   try{entry=parseLedgerEntry({...row,lines:JSON.parse(row.linesJson)});}catch{throw new Error('Ungültige gespeicherte Journalbuchung.');}
   for(const line of entry.lines){
    if(++lineCount>MAX_PERIOD_LINES)throw new LedgerPeriodTooLarge();
    const total=totals.get(line.accountId);if(!total)throw new Error('Konto einer Buchung fehlt.');
    if(line.side==='debit')total.debit+=BigInt(line.amountCents);else total.credit+=BigInt(line.amountCents);
   }
  }
  let income=0n,expense=0n;
  const rowsByAccount=accounts.map(account=>{
   const total=totals.get(account.id)!;
   if(account.kind==='income')income+=total.credit-total.debit;
   if(account.kind==='expense')expense+=total.debit-total.credit;
   return {account,debitCents:total.debit.toString(),creditCents:total.credit.toString(),netDebitCents:(total.debit-total.credit).toString()};
  });
  return {from,to,journalCount,lineCount,accounts:rowsByAccount,incomeCreditMinusDebitCents:income.toString(),expenseDebitMinusCreditCents:expense.toString(),incomeLessExpenseCents:(income-expense).toString()};
 })();
}
