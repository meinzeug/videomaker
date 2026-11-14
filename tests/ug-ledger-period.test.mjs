import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createLedgerAccount,ensureUgLedgerSchema,postLedgerJournal,reverseLedgerJournal,LedgerValidationError} from '../lib/ug-ledger.ts';
import {ledgerPeriodSummary,LedgerPeriodTooLarge} from '../lib/ug-ledger-period.ts';

const bank='11c3267c-c343-41d1-8245-2a88107e7213',income='22c3267c-c343-41d1-8245-2a88107e7213',expense='33c3267c-c343-41d1-8245-2a88107e7213';
const jid=n=>`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`,now='2026-11-13T20:00:00.000Z';
function seed(db){
 ensureUgLedgerSchema(db);
 for(const account of [{id:bank,code:'1200',name:'Bank',kind:'asset'},{id:income,code:'8400',name:'Ertrag',kind:'income'},{id:expense,code:'4900',name:'Aufwand',kind:'expense'}])createLedgerAccount(db,account,now);
}
function entry(db,id,date,lines){return postLedgerJournal(db,{id,occurredOn:date,description:'Beispiel',lines},now);}
const revenue=[{accountId:bank,side:'debit',amountCents:10000},{accountId:income,side:'credit',amountCents:10000}];
const cost=[{accountId:expense,side:'debit',amountCents:3000},{accountId:bank,side:'credit',amountCents:3000}];

test('inclusive period, account sides and reversals use posting dates without changing the journal',()=>{
 const db=new Database(':memory:');seed(db);
 entry(db,jid(1),'2026-02-01',revenue);entry(db,jid(2),'2026-02-02',cost);
 reverseLedgerJournal(db,{id:jid(3),entryId:jid(1),occurredOn:'2026-03-01',reason:'Korrektur'},now);
 const feb=ledgerPeriodSummary(db,'2026-02-01','2026-02-02');
 assert.equal(feb.journalCount,2);assert.equal(feb.lineCount,4);
 assert.equal(feb.incomeCreditMinusDebitCents,'10000');assert.equal(feb.expenseDebitMinusCreditCents,'3000');assert.equal(feb.incomeLessExpenseCents,'7000');
 assert.equal(feb.accounts.find(a=>a.account.id===bank).netDebitCents,'7000');
 const sameDay=ledgerPeriodSummary(db,'2026-02-02','2026-02-02');assert.equal(sameDay.incomeLessExpenseCents,'-3000');
 const march=ledgerPeriodSummary(db,'2026-03-01','2026-03-01');assert.equal(march.incomeCreditMinusDebitCents,'-10000');assert.equal(march.incomeLessExpenseCents,'-10000');
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_journals').get().n,3);db.close();
});
test('invalid dates and reversed ranges fail; an empty interval is explicit',()=>{
 const db=new Database(':memory:');seed(db);
 for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-12-01','2026-01-01'],['2026-01-01','x'],[null,'2026-01-01'],['1899-12-31','1900-01-01']])assert.throws(()=>ledgerPeriodSummary(db,from,to),LedgerValidationError);
 const empty=ledgerPeriodSummary(db,'2024-02-29','2024-02-29');assert.equal(empty.journalCount,0);assert.equal(empty.lineCount,0);assert.equal(empty.incomeLessExpenseCents,'0');db.close();
});
test('large totals remain exact decimal-cent strings',()=>{
 const db=new Database(':memory:');seed(db);const amount=9_999_999_999;
 db.transaction(()=>{for(let n=1;n<=150;n++)entry(db,jid(n),'2026-01-01',[{accountId:bank,side:'debit',amountCents:amount},{accountId:income,side:'credit',amountCents:amount}]);})();
 const result=ledgerPeriodSummary(db,'2026-01-01','2026-01-01');assert.equal(result.incomeLessExpenseCents,(150n*BigInt(amount)).toString());db.close();
});
test('a WAL commit during the report cannot change its snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ug-period-snapshot-'));let db,other;
 try{
  const file=join(dir,'test.sqlite');db=new Database(file);db.pragma('journal_mode = WAL');seed(db);entry(db,jid(1),'2026-01-01',revenue);other=new Database(file);
  const prepare=db.prepare.bind(db);let injected=false;
  db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('SELECT id,code,name,kind,created_at AS createdAt FROM ug_ledger_accounts'))return statement;
   return {all(...args){const result=statement.all(...args);if(!injected){injected=true;entry(other,jid(2),'2026-01-01',revenue);}return result;}};
  };
  const first=ledgerPeriodSummary(db,'2026-01-01','2026-01-01');assert.equal(first.journalCount,1);assert.equal(first.incomeLessExpenseCents,'10000');
  const next=ledgerPeriodSummary(db,'2026-01-01','2026-01-01');assert.equal(next.journalCount,2);assert.equal(next.incomeLessExpenseCents,'20000');
 }finally{other?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('an over-large interval is rejected instead of returning partial totals',()=>{
 const db=new Database(':memory:');seed(db);
 const lines=Array.from({length:128},(_,i)=>({accountId:i%2?income:bank,side:i%2?'credit':'debit',amountCents:1}));
 db.transaction(()=>{for(let n=1;n<=391;n++)entry(db,jid(n),'2026-01-01',lines);})();
 assert.throws(()=>ledgerPeriodSummary(db,'2026-01-01','2026-01-01'),LedgerPeriodTooLarge);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_journals').get().n,391);db.close();
});
test('an over-large account plan reports its own limit rather than suggesting a shorter period',()=>{
 const db=new Database(':memory:');ensureUgLedgerSchema(db);
 const insert=db.prepare('INSERT INTO ug_ledger_accounts(id,code,name,kind,created_at) VALUES(?,?,?,?,?)');
 db.transaction(()=>{for(let n=1;n<=5001;n++)insert.run(jid(n),`T${n}`,'Test','asset',now);})();
 assert.throws(()=>ledgerPeriodSummary(db,'2026-01-01','2026-01-01'),error=>error instanceof LedgerPeriodTooLarge&&/Kontenplan/.test(error.message)&&!/kleineren Zeitraum/.test(error.message));
 db.close();
});
test('missing account source fails instead of presenting misleading totals',()=>{
 const db=new Database(':memory:');seed(db);entry(db,jid(1),'2026-01-01',revenue);
 db.exec('DROP TRIGGER ug_ledger_accounts_no_delete');db.prepare('DELETE FROM ug_ledger_accounts WHERE id=?').run(bank);
 assert.throws(()=>ledgerPeriodSummary(db,'2026-01-01','2026-01-01'),/Konto einer Buchung fehlt/);db.close();
});
