import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createLedgerAccount} from '../lib/ug-ledger.ts';

const base=process.env.LEDGER_EXPORT_TEST_SERVER;
const enabled=!!base&&process.env.LEDGER_EXPORT_TEST_ALLOW_WRITES==='1';
test('isolated HTTP export requires login and includes saved entries and reversals',{skip:!enabled,timeout:60000},async()=>{
 const url=new URL(base);assert.equal(url.href,'http://127.0.0.1:3335/');
 const fixture=realpathSync(process.env.LEDGER_EXPORT_FIXTURE_DIR||'');
 assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.match(basename(fixture),/^videomaker-ledger-export-fixture\.[A-Za-z0-9]{6,}$/);
 const marker=join(fixture,'.ug-export-fixture');assert.equal(realpathSync(marker),marker);
 assert.equal(readFileSync(marker,'utf8'),'isolated-ug-export-fixture\n');
 const origin=url.origin;let cookie='';
 async function call(path,method='GET',body){
  const headers={Origin:origin};if(cookie)headers.Cookie=cookie;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';',1)[0];
  return response;
 }
 let response=await call('/api/ledger/export');assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/);
 response=await call('/api/login','POST',{password:'ledger-local-test'});assert.equal(response.status,200);assert.ok(cookie);
 // Initialise schema, then prove this particular server reads our marked
 // disposable database before sending a single mutating HTTP request.
 response=await call('/api/ledger/accounts');assert.equal(response.status,200);
 const file=join(fixture,'videomaker.sqlite');assert.equal(realpathSync(file),file);
 const database=new Database(file,{fileMustExist:true}),markerId=randomUUID(),markerName=randomUUID();
 try{createLedgerAccount(database,{id:markerId,code:'T'+markerId.replaceAll('-','').slice(0,24),name:markerName,kind:'asset'},new Date().toISOString());}finally{database.close();}
 response=await call('/api/ledger/accounts');assert.equal(response.status,200);
 const markerList=await response.json();assert.ok(markerList.accounts.some(x=>x.id===markerId&&x.name===markerName),'Server muss die markierte Fixture-Datenbank verwenden');
 const a=randomUUID(),b=randomUUID(),id=randomUUID(),reversal=randomUUID();
 for(const account of [{id:a,code:'0001',name:'=1+1',kind:'asset'},{id:b,code:'0002',name:'Erlöse',kind:'income'}]){
  response=await call('/api/ledger/accounts','POST',account);assert.equal(response.status,201);
 }
 response=await call('/api/ledger/journals','POST',{id,occurredOn:'2026-01-02',description:'Beispiel',lines:[{accountId:a,side:'debit',amountCents:1},{accountId:b,side:'credit',amountCents:1}]});assert.equal(response.status,201);
 response=await call(`/api/ledger/journals/${id}/reverse`,'POST',{id:reversal,occurredOn:'2026-01-03',reason:'Test'});assert.equal(response.status,201);
 response=await call('/api/ledger/export');assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/^text\/csv/);assert.match(response.headers.get('content-disposition'),/attachment/);
 assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 const csv=await response.text();assert.ok(csv.includes(id));assert.ok(csv.includes(reversal));assert.ok(csv.includes('\\u003d1+1'));assert.ok(csv.includes('"0,01";"1"'));
 await call('/api/logout','POST');response=await call('/api/ledger/export');assert.equal(response.status,401);
});
