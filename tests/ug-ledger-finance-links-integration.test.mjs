import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createLedgerAccount} from '../lib/ug-ledger.ts';

const base=process.env.LEDGER_LINKS_TEST_SERVER;
const enabled=!!base&&process.env.LEDGER_LINKS_TEST_ALLOW_WRITES==='1';
test('isolated HTTP linking is authenticated, idempotent, and corrected without changing amounts',{skip:!enabled,timeout:60000},async()=>{
 const url=new URL(base);assert.equal(url.href,'http://127.0.0.1:3336/');
 const fixture=realpathSync(process.env.LEDGER_LINKS_FIXTURE_DIR||'');
 assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.match(basename(fixture),/^videomaker-ledger-links-fixture\.[A-Za-z0-9]{6,}$/);
 const marker=join(fixture,'.ug-links-fixture');assert.equal(realpathSync(marker),marker);assert.equal(readFileSync(marker,'utf8'),'isolated-ug-links-fixture\n');
 const origin=url.origin;let cookie='';
 async function call(path,method='GET',body,withOrigin=true){
  const headers={};if(withOrigin)headers.Origin=origin;if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';',1)[0];return response;
 }
 const jid=randomUUID(),fid=randomUUID(),lid=randomUUID().toUpperCase(),uid=randomUUID();let response=await call(`/api/ledger/journals/${jid}/finance-links`);assert.equal(response.status,401);
 response=await call('/api/login','POST',{password:'ledger-local-test'});assert.equal(response.status,200);
 response=await call('/api/ledger/accounts');assert.equal(response.status,200);
 const file=join(fixture,'videomaker.sqlite');assert.equal(realpathSync(file),file);const database=new Database(file,{fileMustExist:true}),markerId=randomUUID(),markerName=randomUUID();
 try{createLedgerAccount(database,{id:markerId,code:'T'+markerId.replaceAll('-','').slice(0,24),name:markerName,kind:'asset'},new Date().toISOString());}finally{database.close();}
 response=await call('/api/ledger/accounts');assert.equal(response.status,200);assert.ok((await response.json()).accounts.some(a=>a.id===markerId&&a.name===markerName),'Server muss die isolierte Fixture-Datenbank verwenden');
 const bank=randomUUID(),income=randomUUID();
 for(const account of [{id:bank,code:'T1200',name:'Bank',kind:'asset'},{id:income,code:'T8400',name:'Ertrag',kind:'income'}])assert.equal((await call('/api/ledger/accounts','POST',account)).status,201);
 assert.equal((await call('/api/ledger/journals','POST',{id:jid,occurredOn:'2026-01-01',description:'Test',lines:[{accountId:bank,side:'debit',amountCents:1000},{accountId:income,side:'credit',amountCents:1000}]})).status,201);
 assert.equal((await call('/api/finance','POST',{action:'entry',id:fid,direction:'income',amountCents:500,occurredOn:'2026-01-01',description:'Teilzahlung',counterparty:'',reference:'',channelId:null})).status,201);
 const root=`/api/ledger/journals/${jid}/finance-links`,link={id:lid,financeEntryId:fid,expectedLinkId:null,expectedUnlinkId:null};
 assert.equal((await call(root,'POST',link,false)).status,403);
 response=await call(root,'POST',link);assert.equal(response.status,201);assert.equal((await response.json()).link.financeAmountCents,500);
 response=await call(root,'POST',link);assert.equal(response.status,200);assert.equal((await response.json()).created,false);
 const duplicateId=randomUUID(),duplicateRequest={id:duplicateId,financeEntryId:fid,expectedLinkId:lid,expectedUnlinkId:null};response=await call(root,'POST',duplicateRequest);assert.equal(response.status,200);const duplicate=await response.json();assert.equal(duplicate.requestId,duplicateId);assert.equal(duplicate.link.id,lid);
 response=await call(root);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal((await response.json()).links.length,1);
 async function delayed(path,requestCookie,body){
  let finish,responded=false;
  const answer=new Promise((resolve,reject)=>{
   const request=http.request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie:requestCookie}},res=>{responded=true;res.resume();res.on('end',()=>resolve(res.statusCode));});
   request.on('error',reject);request.write('{');finish=()=>request.end(JSON.stringify(body).slice(1));
  });
  await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(responded,false);return {answer,finish};
 }
 async function separateSession(){const original=cookie;assert.equal((await call('/api/login','POST',{password:'ledger-local-test'})).status,200);const other=cookie;cookie=original;return other;}
 async function logoutOther(other){const result=await fetch(origin+'/api/logout',{method:'POST',headers:{origin,cookie:other}});assert.equal(result.status,200);}
 const secondFinance=randomUUID();assert.equal((await call('/api/finance','POST',{action:'entry',id:secondFinance,direction:'income',amountCents:500,occurredOn:'2026-01-01',description:'Weitere Teilzahlung',counterparty:'',reference:'',channelId:null})).status,201);
 const other=await separateSession(),pendingLink=await delayed(root,other,{id:randomUUID(),financeEntryId:secondFinance,expectedLinkId:null,expectedUnlinkId:null});
 await logoutOther(other);pendingLink.finish();assert.equal(await pendingLink.answer,403);
 response=await call(root);assert.equal((await response.json()).links.length,1);
 const correction={id:uid,reason:'Falsche Zahlung'},path=`${root}/${lid}/unlink`;
 assert.equal((await call(path,'POST',{})).status,400); // warm route before race
 const third=await separateSession(),pendingCorrection=await delayed(path,third,{id:randomUUID(),reason:'Verspätet'});
 await logoutOther(third);pendingCorrection.finish();assert.equal(await pendingCorrection.answer,403);
 response=await call(root);assert.equal((await response.json()).links[0].unlinkId,null);
 const lateId=randomUUID(),lateRequest={id:lateId,financeEntryId:fid,expectedLinkId:lid,expectedUnlinkId:null},pendingStale=await delayed(root,cookie,lateRequest);
 response=await call(path,'POST',correction);assert.equal(response.status,201);assert.equal((await response.json()).link.unlinkId,uid);
 pendingStale.finish();assert.equal(await pendingStale.answer,200);
 response=await call(root,'POST',lateRequest);assert.equal(response.status,200);assert.equal((await response.json()).outcome,'stale');
 response=await call(path,'POST',correction);assert.equal(response.status,200);assert.equal((await response.json()).created,false);
 const competing={id:randomUUID(),reason:'Anderer Grund'};response=await call(path,'POST',competing);assert.equal(response.status,200);const denied=await response.json();assert.equal(denied.outcome,'already_corrected');assert.equal(denied.link.unlinkReason,correction.reason);
 response=await call(root,'POST',duplicateRequest);assert.equal(response.status,200);assert.equal((await response.json()).link.unlinkId,uid);
 response=await call(root);assert.equal((await response.json()).links[0].unlinkReason,'Falsche Zahlung');
 await call('/api/logout','POST');assert.equal((await call(root)).status,401);
});
