import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createLedgerAccount,postLedgerJournal} from '../lib/ug-ledger.ts';

const base=process.env.LEDGER_PERIOD_TEST_SERVER;
const enabled=!!base&&process.env.LEDGER_PERIOD_TEST_ALLOW_WRITES==='1';
test('isolated period report requires login, validates dates and returns exact journal movements',{skip:!enabled,timeout:60000},async()=>{
 const url=new URL(base);assert.equal(url.href,'http://127.0.0.1:3337/');
 const fixture=realpathSync(process.env.LEDGER_PERIOD_FIXTURE_DIR||'');
 assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.match(basename(fixture),/^videomaker-ledger-period-fixture\.[A-Za-z0-9]{6,}$/);
 const marker=join(fixture,'.ug-period-fixture');assert.equal(realpathSync(marker),marker);assert.equal(readFileSync(marker,'utf8'),'isolated-ug-period-fixture\n');
 const origin=url.origin;let cookie='';
 async function call(path,method='GET',body){
  const headers={Origin:origin};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';',1)[0];return response;
 }
 const path='/api/ledger/period-summary?from=2026-02-01&to=2026-02-02';let response=await call(path);
 assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/);
 response=await call('/api/login','POST',{password:'ledger-local-test'});assert.equal(response.status,200);
 response=await call('/api/ledger/accounts');assert.equal(response.status,200);
 const file=join(fixture,'videomaker.sqlite');assert.equal(realpathSync(file),file);
 const database=new Database(file,{fileMustExist:true}),bank=randomUUID(),income=randomUUID(),journal=randomUUID(),now=new Date().toISOString();
 try{
  createLedgerAccount(database,{id:bank,code:'T1200',name:'Fixture Bank',kind:'asset'},now);
  createLedgerAccount(database,{id:income,code:'T8400',name:'Fixture Ertrag',kind:'income'},now);
  postLedgerJournal(database,{id:journal,occurredOn:'2026-02-01',description:'Fixture',lines:[{accountId:bank,side:'debit',amountCents:12345},{accountId:income,side:'credit',amountCents:12345}]},now);
 }finally{database.close();}
 response=await call('/api/ledger/accounts');assert.ok((await response.json()).accounts.some(a=>a.id===bank),'Server muss die isolierte Fixture-Datenbank verwenden');
 response=await call(path);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 const report=await response.json();assert.equal(report.journalCount,1);assert.equal(report.lineCount,2);assert.equal(report.incomeLessExpenseCents,'12345');assert.equal(report.accounts.find(a=>a.account.id===bank).netDebitCents,'12345');
 assert.equal(Object.hasOwn(report,'reserve'),false);assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
 for(const query of ['?from=2026-02-30&to=2026-03-01','?from=2026-02-02&to=2026-02-01','?from=2026-01-01&from=2026-01-02&to=2026-02-01','?from=2026-01-01&to=2026-02-01&unexpected=1'])assert.equal((await call('/api/ledger/period-summary'+query)).status,400);
 await call('/api/logout','POST');assert.equal((await call(path)).status,401);
});
