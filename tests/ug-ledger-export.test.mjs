import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedgerAccount,ensureUgLedgerSchema,postLedgerJournal,reverseLedgerJournal} from '../lib/ug-ledger.ts';
import {exportLedgerCsv,LedgerExportTooLarge} from '../lib/ug-ledger-export.ts';

const now='2026-11-13T20:00:00.000Z';
const bank='11c3267c-c343-41d1-8245-2a88107e7213',income='22c3267c-c343-41d1-8245-2a88107e7213';
const journal=n=>`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`;
const lines=[{accountId:bank,side:'debit',amountCents:12345},{accountId:income,side:'credit',amountCents:12345}];
function fixture(){
 const db=new Database(':memory:');ensureUgLedgerSchema(db);
 createLedgerAccount(db,{id:bank,code:'01200',name:'=SUM(1;2)',kind:'asset'},now);
 createLedgerAccount(db,{id:income,code:'8400',name:'Erlöse',kind:'income'},now);
 return db;
}
// Parse independently, including quoted semicolons, escaped quotes and CRLF.
function csv(source){
 const result=[];let row=[],cell='',quoted=false;
 for(let i=source.charCodeAt(0)===0xfeff?1:0;i<source.length;i++){
  const c=source[i];
  if(quoted){if(c==='"'&&source[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
  else if(c==='"')quoted=true;
  else if(c===';'){row.push(cell);cell='';}
  else if(c==='\r'&&source[i+1]==='\n'){row.push(cell);result.push(row);row=[];cell='';i++;}
  else cell+=c;
 }
 assert.equal(quoted,false);assert.deepEqual(row,[]);assert.equal(cell,'');return result;
}
test('complete journal export preserves cents, accounts, original and reversal, and neutralizes spreadsheet formulas',()=>{
 const db=fixture();
 postLedgerJournal(db,{id:journal(1),occurredOn:'2026-02-01',description:' =HYPERLINK("x";"y")',lines},now);
 reverseLedgerJournal(db,{id:journal(2),entryId:journal(1),occurredOn:'2026-02-02',reason:'@test'},now);
 const output=exportLedgerCsv(db);assert.ok(output.startsWith('\uFEFF'));const [header,...rows]=csv(output);
 assert.equal(rows.length,4);assert.equal(header.length,16);assert.ok(rows.every(r=>r.length===header.length));
 const original=rows.filter(r=>r[1]===journal(1)),reversal=rows.filter(r=>r[1]===journal(2));
 assert.equal(original.length,2);assert.equal(reversal.length,2);
 assert.equal(original[0][3],"\\u003dHYPERLINK(\"x\";\"y\")");
 assert.equal(original[0][10],'01200');assert.equal(original[0][11],"\\u003dSUM(1;2)");
 assert.equal(original[0][14],'123,45');assert.equal(original[0][15],'12345');
 assert.equal(original[0][13],'Soll');assert.equal(reversal[0][13],'Haben');
 assert.equal(reversal[0][5],journal(1));assert.equal(reversal[0][6],"\\u0040test");
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_journals').get().n,2);db.close();
});
test('export includes all journal pages rather than only currently visible entries',()=>{
 const db=fixture();
 db.transaction(()=>{for(let n=1;n<=101;n++)postLedgerJournal(db,{id:journal(n),occurredOn:'2026-01-01',description:'Test',lines},now);})();
 const rows=csv(exportLedgerCsv(db));assert.equal(rows.length,203);
 assert.deepEqual(new Set(rows.slice(1).map(r=>r[1])).size,101);db.close();
});
test('a concurrent WAL commit cannot split an export across snapshots',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ug-export-snapshot-'));let db,other;
 try{
  const file=join(dir,'test.sqlite');db=new Database(file);db.pragma('journal_mode = WAL');ensureUgLedgerSchema(db);
  createLedgerAccount(db,{id:bank,code:'01200',name:'Bank',kind:'asset'},now);
  createLedgerAccount(db,{id:income,code:'8400',name:'Erlöse',kind:'income'},now);
  db.transaction(()=>{for(let n=1;n<=101;n++)postLedgerJournal(db,{id:journal(n),occurredOn:'2026-01-01',description:'Test',lines},now);})();
  other=new Database(file);let injected=false;const prepare=db.prepare.bind(db);
  db.prepare=sql=>{
   const statement=prepare(sql);
   if(!sql.includes('ORDER BY j.rowid DESC LIMIT ?'))return statement;
   return {all(...args){const result=statement.all(...args);if(!injected){injected=true;postLedgerJournal(other,{id:journal(102),occurredOn:'2026-01-01',description:'Nachträglich',lines},now);}return result;}};
  };
  const during=csv(exportLedgerCsv(db));assert.equal(injected,true);assert.equal(during.length,203);assert.ok(!during.some(row=>row[1]===journal(102)));
  const after=csv(exportLedgerCsv(db));assert.equal(after.length,205);assert.equal(after.filter(row=>row[1]===journal(102)).length,2);
 }finally{other?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('formula-like text is neutralized for each spreadsheet formula prefix',()=>{
 const db=fixture(),values=['=cmd','+cmd','-cmd','@cmd',"'=cmd",'＝cmd','＋cmd','－cmd','＠cmd'];
 for(const [index,description] of values.entries())postLedgerJournal(db,{id:journal(index+1),occurredOn:'2026-01-01',description,lines},now);
 const descriptions=csv(exportLedgerCsv(db)).slice(1).filter((_,i)=>i%2===0).map(row=>row[3]);
 for(const value of values)assert.ok(descriptions.includes(`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}${value.slice(1)}`));
 db.close();
});
test('empty journal has headers; oversize export fails without returning a partial file',()=>{
 const db=fixture();assert.equal(csv(exportLedgerCsv(db)).length,1);
 const many=Array.from({length:128},(_,i)=>({accountId:i%2?income:bank,side:i%2?'credit':'debit',amountCents:1}));
 db.transaction(()=>{for(let n=1;n<=391;n++)postLedgerJournal(db,{id:journal(n),occurredOn:'2026-01-01',description:'Test',lines:many},now);})();
 assert.throws(()=>exportLedgerCsv(db),LedgerExportTooLarge);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ug_ledger_journals').get().n,391);db.close();
});
