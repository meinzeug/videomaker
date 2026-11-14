import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {createLedgerAccount,ensureUgLedgerSchema,postLedgerJournal} from '../lib/ug-ledger.ts';
import {exportLedgerCsv} from '../lib/ug-ledger-export.ts';

test('isolated LibreOffice import, save and reopen do not turn masked texts into formulas',{skip:process.env.RUN_CALC_EXPORT_TEST!=='1',timeout:90000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'ug-export-calc-')),profile=join(dir,'profile'),output=join(dir,'output');
 const db=new Database(':memory:');
 try{
  mkdirSync(output);ensureUgLedgerSchema(db);
  const now='2026-11-13T20:00:00.000Z',bank='11c3267c-c343-41d1-8245-2a88107e7213',income='22c3267c-c343-41d1-8245-2a88107e7213';
  createLedgerAccount(db,{id:bank,code:'01200',name:'=1+1',kind:'asset'},now);
  createLedgerAccount(db,{id:income,code:'8400',name:'Erlöse',kind:'income'},now);
  const values=['=1+1','+1+1','-1+1','@SUM(1)',"'=1+1",'＝1+1','＋1+1','－1+1','＠SUM(1)'];
  for(const [i,description] of values.entries())postLedgerJournal(db,{id:`${String(i+1).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`,occurredOn:'2026-01-01',description,lines:[{accountId:bank,side:'debit',amountCents:1},{accountId:income,side:'credit',amountCents:1}]},now);
  const input=join(dir,'journal.csv');writeFileSync(input,exportLedgerCsv(db));
  const common=[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--convert-to'];
  execFileSync('libreoffice',[...common,'ods','--outdir',output,input],{timeout:45000,stdio:'pipe'});
  const ods=join(output,'journal.ods');
  const content=execFileSync('unzip',['-p',ods,'content.xml'],{encoding:'utf8',timeout:10000,maxBuffer:5_000_000});
  assert.doesNotMatch(content,/table:formula\s*=/i);
  for(const value of values)assert.ok(content.includes(`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}${value.slice(1)}`));
  // Reopen ODS and save XLSX; a generated formula would appear as an <f> element.
  execFileSync('libreoffice',[...common,'xlsx','--outdir',output,ods],{timeout:45000,stdio:'pipe'});
  const xlsx=join(output,'journal.xlsx');
  const sheet=execFileSync('unzip',['-p',xlsx,'xl/worksheets/sheet1.xml'],{encoding:'utf8',timeout:10000,maxBuffer:5_000_000});
  assert.doesNotMatch(sheet,/<(?:\w+:)?f(?:\s|>)/i);
  const entries=execFileSync('unzip',['-Z1',xlsx],{encoding:'utf8',timeout:10000,maxBuffer:5_000_000});
  const strings=entries.split('\n').includes('xl/sharedStrings.xml')?execFileSync('unzip',['-p',xlsx,'xl/sharedStrings.xml'],{encoding:'utf8',timeout:10000,maxBuffer:5_000_000}):sheet;
  for(const value of values)assert.ok(strings.includes(`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}${value.slice(1)}`));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
