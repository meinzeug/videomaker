import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureFinanceSchema,createFinanceEntry,reverseFinanceEntry} from '../lib/finance-store.ts';
import {ensureUgLedgerSchema,createLedgerAccount,postLedgerJournal,reverseLedgerJournal,ledgerBalances,LedgerConflict,LedgerNotFound,LedgerValidationError} from '../lib/ug-ledger.ts';
import {ensureLedgerFinanceLinksSchema,attachLedgerFinance,unlinkLedgerFinance,listLedgerFinanceLinks} from '../lib/ug-ledger-finance-links.ts';

const ids={bank:'11c3267c-c343-41d1-8245-2a88107e7213',income:'22c3267c-c343-41d1-8245-2a88107e7213',journal:'33c3267c-c343-41d1-8245-2a88107e7213',journal2:'44c3267c-c343-41d1-8245-2a88107e7213',finance:'55c3267c-c343-41d1-8245-2a88107e7213',finance2:'66c3267c-c343-41d1-8245-2a88107e7213',link:'77c3267c-c343-41d1-8245-2a88107e7213',link2:'88c3267c-c343-41d1-8245-2a88107e7213',unlink:'99c3267c-c343-41d1-8245-2a88107e7213'};
const now='2026-11-14T10:00:00.000Z';
const attach=(db,journal,input,now,expectedLinkId=null,expectedUnlinkId=null)=>attachLedgerFinance(db,journal,{...input,expectedLinkId,expectedUnlinkId},now);
function fixture(){
 const db=new Database(':memory:');ensureFinanceSchema(db);ensureUgLedgerSchema(db);ensureLedgerFinanceLinksSchema(db);
 createLedgerAccount(db,{id:ids.bank,code:'1200',name:'Bank',kind:'asset'},now);createLedgerAccount(db,{id:ids.income,code:'8400',name:'Ertrag',kind:'income'},now);
 const lines=[{accountId:ids.bank,side:'debit',amountCents:2000},{accountId:ids.income,side:'credit',amountCents:2000}];
 for(const id of [ids.journal,ids.journal2])postLedgerJournal(db,{id,occurredOn:'2026-01-01',description:'Journal',lines},now);
 for(const [id,amountCents] of [[ids.finance,1000],[ids.finance2,500]])createFinanceEntry(db,{id,direction:'income',amountCents,occurredOn:'2026-01-02',description:'Teilzahlung',counterparty:'',reference:'',channelId:null},now);
 return db;
}
test('explicit many-to-many references preserve both originals and do not post or compare amounts',()=>{
 const db=fixture(),before=ledgerBalances(db);
 const first=attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 assert.equal(first.created,true);assert.equal(first.link.financeAmountCents,1000);
 assert.equal(attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now).created,false);
 assert.throws(()=>attach(db,ids.journal2,{id:ids.link,financeEntryId:ids.finance},now),LedgerConflict);
 const duplicate=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now,ids.link,null);
 assert.equal(duplicate.created,false);assert.equal(duplicate.link.id,ids.link);assert.equal(duplicate.requestId,ids.link2);
 attach(db,ids.journal,{id:ids.unlink,financeEntryId:ids.finance2},now);
 attach(db,ids.journal2,{id:ids.finance2.replace('66','aa'),financeEntryId:ids.finance},now);
 assert.equal(listLedgerFinanceLinks(db,ids.journal).length,2);assert.equal(listLedgerFinanceLinks(db,ids.journal2).length,1);
 assert.deepEqual(ledgerBalances(db),before);assert.equal(db.prepare('SELECT count(*) AS n FROM finance_entries').get().n,2);db.close();
});
test('a correction is append-only, idempotent, preserves history, and permits a new explicit reference',()=>{
 const db=fixture();attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 const corrected=unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Falsche Zahlung'},now);
 assert.equal(corrected.created,true);assert.equal(corrected.link.unlinkReason,'Falsche Zahlung');
 assert.equal(unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Falsche Zahlung'},now).created,false);
 assert.equal(attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now).link.unlinkId,ids.unlink);
 assert.throws(()=>unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Anderer Grund'},now),LedgerConflict);
 assert.throws(()=>unlinkLedgerFinance(db,ids.journal2,ids.link,{id:ids.link2,reason:'Falsch'},now),LedgerNotFound);
 attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now,ids.link,ids.unlink);
 const history=listLedgerFinanceLinks(db,ids.journal);assert.equal(history.length,2);assert.equal(history.filter(l=>!l.unlinkId).length,1);
 for(const table of ['ug_ledger_finance_links','ug_ledger_finance_unlinks','ug_ledger_finance_link_requests','ug_ledger_finance_unlink_requests']){
  assert.throws(()=>db.prepare(`DELETE FROM ${table}`).run(),/cannot be deleted/);
  assert.throws(()=>db.prepare(`UPDATE ${table} SET created_at=?`).run(now),/cannot be updated/);
 }
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO ug_ledger_finance_links(id,journal_id,finance_entry_id,created_at) VALUES(?,?,?,?)').run(ids.link,ids.journal,ids.finance,now),/link already exists/);
 db.close();
});
test('a concurrent duplicate has its own stable receipt and never reactivates after a later correction',()=>{
 const db=fixture();const first=attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 const second=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now,ids.link,null);
 assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(second.link.id,first.link.id);
 unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Irrtum'},now);
 const retry=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now,ids.link,null);
 assert.equal(retry.requestId,ids.link2);assert.equal(retry.link.id,ids.link);assert.equal(retry.link.unlinkId,ids.unlink);
 assert.equal(listLedgerFinanceLinks(db,ids.journal).filter(link=>!link.unlinkId).length,0);
 assert.throws(()=>attach(db,ids.journal2,{id:ids.link2,financeEntryId:ids.finance},now,ids.link,null),LedgerConflict);db.close();
});
test('a delayed old request cannot revive a corrected pair, and a deliberate new one can',()=>{
 const db=fixture();attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Irrtum'},now);
 const late=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now);
 assert.equal(late.outcome,'stale');assert.equal(late.link,null);
 const freshId=ids.finance2.replace('66','aa');
 const fresh=attach(db,ids.journal,{id:freshId,financeEntryId:ids.finance},now,ids.link,ids.unlink);
 assert.equal(fresh.outcome,'linked');assert.equal(fresh.created,true);
 const retry=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now);
 assert.equal(retry.outcome,'stale');assert.equal(retry.link,null);assert.equal(listLedgerFinanceLinks(db,ids.journal).filter(l=>!l.unlinkId).length,1);db.close();
});
test('a second correction with a different reason has a durable non-mutating outcome',()=>{
 const db=fixture();attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 const first=unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Erster Grund'},now);assert.equal(first.outcome,'corrected');
 const second=unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.link2,reason:'Anderer Grund'},now);
 assert.equal(second.outcome,'already_corrected');assert.equal(second.requestedReason,'Anderer Grund');assert.equal(second.link.unlinkReason,'Erster Grund');
 assert.equal(unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.link2,reason:'Anderer Grund'},now).outcome,'already_corrected');
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_unlinks').get().n,1);db.close();
});
test('two requests prepared from the same older state settle deterministically',()=>{
 const db=fixture();const first=attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 const second=attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now);
 assert.equal(first.outcome,'linked');assert.equal(second.outcome,'stale');assert.equal(second.link,null);
 assert.equal(attach(db,ids.journal,{id:ids.link2,financeEntryId:ids.finance},now).outcome,'stale');
 assert.equal(listLedgerFinanceLinks(db,ids.journal).filter(x=>!x.unlinkId).length,1);db.close();
});
test('an exhausted history limit has a durable non-mutating receipt',()=>{
 const db=fixture(),event=n=>`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`;
 let previousLink=null,previousUnlink=null;
 for(let n=1;n<=500;n++){
  const id=event(n),unlinkId=event(n+1000);
  assert.equal(attach(db,ids.journal,{id,financeEntryId:ids.finance},now,previousLink,previousUnlink).outcome,'linked');
  assert.equal(unlinkLedgerFinance(db,ids.journal,id,{id:unlinkId,reason:'Test'},now).outcome,'corrected');
  previousLink=id;previousUnlink=unlinkId;
 }
 const requestId=event(2000),limited=attach(db,ids.journal,{id:requestId,financeEntryId:ids.finance},now,previousLink,previousUnlink);
 assert.equal(limited.outcome,'limit');assert.equal(limited.link,null);assert.equal(limited.created,false);
 assert.equal(attach(db,ids.journal,{id:requestId,financeEntryId:ids.finance},now,previousLink,previousUnlink).outcome,'limit');
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links').get().n,500);db.close();
});
test('a failed SQLite commit rolls back both the reference and its receipt',()=>{
 const db=fixture();db.pragma('foreign_keys = ON');
 db.exec(`CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY);
  CREATE TABLE fixture_child(parent_id INTEGER,FOREIGN KEY(parent_id) REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE TRIGGER fixture_fail_commit AFTER INSERT ON ug_ledger_finance_link_requests BEGIN INSERT INTO fixture_child(parent_id) VALUES(1); END;`);
 assert.throws(()=>attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now),/FOREIGN KEY/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links').get().n,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_link_requests').get().n,0);
 db.exec('DROP TRIGGER fixture_fail_commit');assert.equal(attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now).outcome,'linked');
 db.exec(`CREATE TRIGGER fixture_fail_correction_commit AFTER INSERT ON ug_ledger_finance_unlink_requests BEGIN INSERT INTO fixture_child(parent_id) VALUES(1); END;`);
 assert.throws(()=>unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'Irrtum'},now),/FOREIGN KEY/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_unlinks').get().n,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_unlink_requests').get().n,0);db.close();
});
test('invalid or missing records fail without creating links; reversals stay separate',()=>{
 const db=fixture();
 assert.throws(()=>attach(db,ids.journal,{id:ids.link,financeEntryId:ids.unlink},now),LedgerNotFound);
 assert.throws(()=>attach(db,ids.unlink,{id:ids.link,financeEntryId:ids.finance},now),LedgerNotFound);
 assert.throws(()=>attach(db,ids.journal,{id:'bad',financeEntryId:ids.finance},now),LedgerValidationError);
 assert.equal(listLedgerFinanceLinks(db,ids.journal).length,0);
 reverseFinanceEntry(db,{id:ids.finance2.replace('66','aa'),entryId:ids.finance,reason:'Fehler'},now);
 reverseLedgerJournal(db,{id:ids.journal2.replace('44','bb'),entryId:ids.journal,occurredOn:'2026-01-03',reason:'Fehler'},now);
 assert.equal(listLedgerFinanceLinks(db,ids.journal).length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links').get().n,0);
 attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 assert.equal(listLedgerFinanceLinks(db,ids.journal)[0].financeReversed,true);
 assert.throws(()=>unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'  '},now),LedgerValidationError);
 assert.throws(()=>unlinkLedgerFinance(db,ids.journal,ids.link,{id:ids.unlink,reason:'falsch\nTest'},now),LedgerValidationError);
 assert.equal(listLedgerFinanceLinks(db,ids.journal)[0].unlinkId,null);db.close();
});
test('a damaged or missing source does not silently hide a recorded reference',()=>{
 const db=fixture();attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 // Simulate out-of-band damage; normal API and database triggers forbid deletion.
 db.exec('DROP TRIGGER finance_entries_no_delete');db.prepare('DELETE FROM finance_entries WHERE id=?').run(ids.finance);
 assert.throws(()=>listLedgerFinanceLinks(db,ids.journal),/Finanzvorgang einer Zuordnung fehlt/);
 assert.throws(()=>attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now),/Quelle eines Zuordnungsbelegs fehlt/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links').get().n,1);db.close();
});
test('a missing journal source cannot be acknowledged on retry',()=>{
 const db=fixture();attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now);
 db.exec('DROP TRIGGER ug_ledger_journals_no_delete');db.prepare('DELETE FROM ug_ledger_journals WHERE id=?').run(ids.journal);
 assert.throws(()=>attach(db,ids.journal,{id:ids.link,financeEntryId:ids.finance},now),/Quelle eines Zuordnungsbelegs fehlt/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links').get().n,1);db.close();
});
