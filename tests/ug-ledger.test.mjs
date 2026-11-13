import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureUgLedgerSchema,createLedgerAccount,postLedgerJournal,reverseLedgerJournal,listLedgerJournals,ledgerBalances,parseLedgerEntry,LedgerConflict,LedgerNotFound,LedgerValidationError,MAX_LEDGER_LINE_CENTS} from '../lib/ug-ledger.ts';
const ids={bank:'11c3267c-c343-41d1-8245-2a88107e7213',income:'22c3267c-c343-41d1-8245-2a88107e7213',expense:'33c3267c-c343-41d1-8245-2a88107e7213',journal:'44c3267c-c343-41d1-8245-2a88107e7213',reversal:'55c3267c-c343-41d1-8245-2a88107e7213',missing:'66c3267c-c343-41d1-8245-2a88107e7213'};
const now='2026-11-13T20:00:00.000Z';
const accounts=[{id:ids.bank,code:'1200',name:'Bank',kind:'asset'},{id:ids.income,code:'8400',name:'Erlöse',kind:'income'},{id:ids.expense,code:'4900',name:'Aufwand',kind:'expense'}];
const lines=[{accountId:ids.bank,side:'debit',amountCents:12345},{accountId:ids.income,side:'credit',amountCents:12345}];
const entry={id:ids.journal,occurredOn:'2024-02-29',description:'  Geschäftsvorfall  ',lines};
function database(){const d=new Database(':memory:');ensureUgLedgerSchema(d);for(const account of accounts)createLedgerAccount(d,account,now);return d;}
test('account creation is validated, append-only and idempotent',()=>{
 const d=database();
 assert.equal(createLedgerAccount(d,accounts[0],now).created,false);
 assert.throws(()=>createLedgerAccount(d,{...accounts[0],name:'Anders'},now),LedgerConflict);
 assert.throws(()=>createLedgerAccount(d,{...accounts[0],id:ids.missing},now),LedgerConflict);
 assert.throws(()=>createLedgerAccount(d,{...accounts[0],id:ids.missing,code:'../x'},now),LedgerValidationError);
 assert.throws(()=>createLedgerAccount(d,{...accounts[0],id:ids.missing,code:'1199'},'2026-02-30T12:00:00Z'),LedgerValidationError);
 assert.throws(()=>d.prepare('INSERT INTO ug_ledger_accounts(id,code,name,kind,created_at) VALUES(?,?,?,?,?)').run('x'.repeat(36),'1199','Test','asset',now),/CHECK constraint/);
 assert.throws(()=>d.prepare('INSERT INTO ug_ledger_accounts(id,code,name,kind,created_at) VALUES(?,?,?,?,?)').run(ids.missing,'../BAD','Test','asset',now),/CHECK constraint/);
 assert.throws(()=>d.prepare('UPDATE ug_ledger_accounts SET name=? WHERE id=?').run('Andere',ids.bank),/cannot be updated/);
 assert.throws(()=>d.prepare('DELETE FROM ug_ledger_accounts WHERE id=?').run(ids.bank),/cannot be deleted/);
 assert.throws(()=>d.prepare('INSERT OR REPLACE INTO ug_ledger_accounts(id,code,name,kind,created_at) VALUES(?,?,?,?,?)').run(ids.bank,'1200','Ersatz','asset',now),/already exists/);
 assert.equal(d.prepare('SELECT name FROM ug_ledger_accounts WHERE id=?').get(ids.bank).name,'Bank');d.close();
});
test('journal validates dates, accounts, positive integer cents and balanced lines',()=>{
 const d=database();
 const bad=[{occurredOn:'2023-02-29'},{description:' '},{lines:[lines[0]]},{lines:[lines[0],{...lines[1],amountCents:12344}]},{lines:[lines[0],{...lines[1],amountCents:1.5}]},{lines:[lines[0],{...lines[1],amountCents:MAX_LEDGER_LINE_CENTS+1}]},{lines:[lines[0],{...lines[1],accountId:ids.bank}]},{lines:[lines[0],{...lines[1],side:'invalid'}]}];
 for(const change of bad)assert.throws(()=>postLedgerJournal(d,{...entry,...change},now),LedgerValidationError);
 assert.throws(()=>postLedgerJournal(d,{...entry,lines:[lines[0],{...lines[1],accountId:ids.missing}]},now),LedgerNotFound);
 assert.equal(d.prepare('SELECT COUNT(*) AS count FROM ug_ledger_journals').get().count,0);
 const created=postLedgerJournal(d,entry,now);assert.equal(created.created,true);assert.equal(created.journal.description,'Geschäftsvorfall');
 assert.equal(postLedgerJournal(d,entry,'2026-11-14T10:00:00Z').created,false);
 assert.throws(()=>postLedgerJournal(d,{...entry,description:'Anders'},now),LedgerConflict);
 assert.equal(d.prepare('SELECT COUNT(*) AS count FROM ug_ledger_journals').get().count,1);d.close();
});
test('database rejects unbalanced, orphaned and replace-insert journal rows',()=>{
 const d=database();
 const insert=d.prepare('INSERT INTO ug_ledger_journals(id,occurred_on,description,created_at,kind,lines_json) VALUES(?,?,?,?,?,?)');
 assert.throws(()=>insert.run(ids.journal,'2026-01-01','Test',now,'entry',JSON.stringify([lines[0],{...lines[1],amountCents:1}])),/not balanced/);
 assert.throws(()=>insert.run(ids.journal,'2026-01-01','Test',now,'entry',JSON.stringify([lines[0],{...lines[1],accountId:ids.missing}])),/invalid journal line/);
 assert.throws(()=>insert.run(ids.journal,'2026-02-30','Test',now,'entry',JSON.stringify(lines)),/CHECK constraint/);
 postLedgerJournal(d,entry,now);
 assert.throws(()=>d.prepare('UPDATE ug_ledger_journals SET description=? WHERE id=?').run('Andere',ids.journal),/cannot be updated/);
 assert.throws(()=>d.prepare('DELETE FROM ug_ledger_journals WHERE id=?').run(ids.journal),/cannot be deleted/);
 assert.throws(()=>d.prepare('INSERT OR REPLACE INTO ug_ledger_journals(id,occurred_on,description,created_at,kind,lines_json) VALUES(?,?,?,?,?,?)').run(ids.journal,'2026-01-01','Test',now,'entry',JSON.stringify(lines)),/already exists/);
 assert.equal(d.prepare('SELECT COUNT(*) AS count FROM ug_ledger_journals').get().count,1);d.close();
});
test('reversal preserves the original and flips every line exactly once',()=>{
 const d=database();postLedgerJournal(d,entry,now);
 const request={id:ids.reversal,entryId:ids.journal,occurredOn:'2026-11-14',reason:'Falscher Betrag'};
 const r=reverseLedgerJournal(d,request,now);assert.equal(r.created,true);assert.equal(r.journal.reversalOf,ids.journal);assert.deepEqual(r.journal.lines,[{...lines[0],side:'credit'},{...lines[1],side:'debit'}]);
 assert.equal(reverseLedgerJournal(d,request,now).created,false);
 assert.throws(()=>reverseLedgerJournal(d,{...request,reason:'Anders'},now),LedgerConflict);
 assert.throws(()=>reverseLedgerJournal(d,{...request,id:ids.missing},now),LedgerConflict);
 assert.throws(()=>reverseLedgerJournal(d,{...request,id:ids.missing,entryId:ids.reversal},now),LedgerNotFound);
 const page=listLedgerJournals(d,null,1);assert.equal(page.journals[0].id,ids.reversal);assert.ok(page.nextBefore);assert.equal(listLedgerJournals(d,page.nextBefore,1).journals[0].reversed,true);
 for(const balance of ledgerBalances(d))assert.equal(balance.netDebitCents,'0');
 d.close();
});
test('database refuses fabricated or duplicate reversals',()=>{
 const d=database();postLedgerJournal(d,entry,now);
 const insert=d.prepare('INSERT INTO ug_ledger_journals(id,occurred_on,description,created_at,kind,reversal_of,reversal_reason,lines_json) VALUES(?,?,?,?,?,?,?,?)');
 assert.throws(()=>insert.run(ids.reversal,'2026-11-14','Geschäftsvorfall',now,'reversal',ids.journal,'Fehler',JSON.stringify(lines)),/invalid reversal lines/);
 assert.throws(()=>insert.run(ids.reversal,'2026-11-14','Geschäftsvorfall',now,'reversal',ids.journal,null,JSON.stringify([{...lines[0],side:'credit'},{...lines[1],side:'debit'}])),/CHECK constraint/);
 reverseLedgerJournal(d,{id:ids.reversal,entryId:ids.journal,occurredOn:'2026-11-14',reason:'Fehler'},now);
 assert.throws(()=>insert.run(ids.missing,'2026-11-14','Geschäftsvorfall',now,'reversal',ids.journal,'Fehler',JSON.stringify([{...lines[0],side:'credit'},{...lines[1],side:'debit'}])),/already reversed/);
 assert.equal(d.prepare('SELECT COUNT(*) AS count FROM ug_ledger_journals').get().count,2);d.close();
});
test('balances use exact integer arithmetic and return decimal cent strings',()=>{
 const d=database();
 const lineAmount=9_999_999_999;
 for(let n=0;n<40;n++){
  const journalId=`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`;
  postLedgerJournal(d,{id:journalId,occurredOn:'2026-01-01',description:'Test',lines:[{accountId:ids.bank,side:'debit',amountCents:lineAmount},{accountId:ids.income,side:'credit',amountCents:lineAmount}]},now);
 }
 const balances=ledgerBalances(d),bank=balances.find(b=>b.account.id===ids.bank),income=balances.find(b=>b.account.id===ids.income);
 assert.equal(bank.debitCents,(40n*BigInt(lineAmount)).toString());assert.equal(bank.creditCents,'0');
 assert.equal(income.netDebitCents,(-40n*BigInt(lineAmount)).toString());
 assert.equal(listLedgerJournals(d,null,10).journals.length,10);
 assert.throws(()=>listLedgerJournals(d,0,10),LedgerValidationError);
 assert.throws(()=>listLedgerJournals(d,null,101),LedgerValidationError);d.close();
});
