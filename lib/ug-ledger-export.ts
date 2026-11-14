import type Database from 'better-sqlite3';
import {listLedgerJournals, type LedgerAccount} from './ug-ledger.ts';

// Bound CPU and memory, and never silently return a partial journal.
export const MAX_EXPORT_JOURNALS=10_000;
export const MAX_EXPORT_LINES=50_000;
export const MAX_EXPORT_BYTES=20*1024*1024;
export class LedgerExportTooLarge extends Error {
 constructor(){super('Das Journal ist für einen vollständigen CSV-Export zu groß. Es wurde keine Datei erstellt.');}
}

/** CSV quoting also prevents delimiters, quotes and line breaks creating new cells. */
function textCell(value:string):string {
 // Quoting and apostrophe-prefixing are not reliable through spreadsheet
 // save/reopen. Replace dangerous initial characters with literal Unicode escapes;
 // this intentionally changes the exported display text, not the journal itself.
 let safe=value.replace(/^[\t\r\n]+/u, controls=>[...controls].map(c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join(''));
 safe=safe.replace(/^([\s\uFEFF]*)([=+\-@'\uFF1D\uFF0B\uFF0D\uFF20])/u,(_,space:string,first:string)=>`${space}\\u${first.charCodeAt(0).toString(16).padStart(4,'0')}`);
 return `"${safe.replaceAll('"','""')}"`;
}
function amount(cents:number):string {
 return `${Math.floor(cents/100)},${String(cents%100).padStart(2,'0')}`;
}
const headers=['Journalfolge','Buchungs-ID','Buchungsdatum','Beschreibung','Art','Storno von ID','Stornogrund','Erfasst UTC','Zeile','Konto-ID','Kontonummer','Kontoname','Kontoart','Seite','Betrag EUR','Betrag Cent'];

/** One consistent SQLite snapshot, including reversals and every journal page. */
export function exportLedgerCsv(database:Database.Database):string {
 return database.transaction(()=>{
  const chunks:string[]=['\uFEFF'+headers.map(textCell).join(';')+'\r\n'];
  let bytes=Buffer.byteLength(chunks[0]),journalCount=0,lineCount=0;
  const accounts=new Map<string,LedgerAccount>();
  const findAccount=database.prepare('SELECT id,code,name,kind,created_at AS createdAt FROM ug_ledger_accounts WHERE id=?');
  let before:number|null=null;
  do {
   const page=listLedgerJournals(database,before,100);
   for(const journal of page.journals){
    if(++journalCount>MAX_EXPORT_JOURNALS)throw new LedgerExportTooLarge();
    for(const [index,line] of journal.lines.entries()){
     if(++lineCount>MAX_EXPORT_LINES)throw new LedgerExportTooLarge();
     let account=accounts.get(line.accountId);
     if(!account){account=findAccount.get(line.accountId) as LedgerAccount|undefined;if(!account)throw new Error('Konto einer Buchung fehlt.');accounts.set(line.accountId,account);}
     const cells=[String(journal.sequence),journal.id,journal.occurredOn,journal.description,journal.kind==='entry'?'Buchung':'Storno',journal.reversalOf||'',journal.reversalReason||'',journal.createdAt,String(index+1),account.id,account.code,account.name,account.kind,line.side==='debit'?'Soll':'Haben',amount(line.amountCents),String(line.amountCents)];
     const row=cells.map(textCell).join(';')+'\r\n';bytes+=Buffer.byteLength(row);
     if(bytes>MAX_EXPORT_BYTES)throw new LedgerExportTooLarge();
     chunks.push(row);
    }
   }
   before=page.nextBefore;
  } while(before!==null);
  return chunks.join('');
 })();
}
