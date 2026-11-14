import test from 'node:test';
import assert from 'node:assert/strict';
import { fork,spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { signSessionBody } from '../lib/session-cookie.ts';
import { createHash } from 'node:crypto';
import { verifiedSessionBindingProof } from '../lib/session-binding-proof.ts';
import { revokeSession,sessionRevoked } from '../lib/session-revocations.ts';
import { createOidcSessionBindings,initializeOidcSessionBindings } from '../lib/oidc-session-bindings.ts';

const secret='isolated-test-secret-at-least-32-characters';
const makeCookie=(expiry,nonce='synthetic')=>{const body=`${expiry}.${nonce}`;return `${body}.${signSessionBody(body,secret)}`;};
function fixture(){
 const db=new Database(':memory:');
 sessionRevoked(db,secret,'seed');
 initializeOidcSessionBindings(db);
 let clock=1_800_000_000_000;
 const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret,clock),()=>clock,()=>secret);
 return {db,binding,now:()=>clock,advance:(n)=>{clock+=n;}};
}

test('Referenz bindet echten signierten Sitzungscookie an denselben Widerruf ohne das Cookie zu speichern',()=>{
 const {db,binding,now}=fixture();
 try {
  const cookie=makeCookie(now()+60_000),other=makeCookie(now()+60_000,'other');
  const ref=binding.issue(cookie),otherRef=binding.issue(other);
  assert.match(ref,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(binding.isActive(ref),true);
  assert.equal(binding.isActive(otherRef),true);
  const bytes=db.serialize();
  assert.equal(bytes.includes(Buffer.from(cookie)),false);
  assert.equal(bytes.includes(Buffer.from(ref)),false);
  revokeSession(db,secret,cookie,now());
  assert.equal(binding.isActive(ref),false);
  assert.equal(binding.isActive(otherRef),true);
  assert.equal(binding.issue(cookie),null);
 } finally {db.close();}
});

test('Cookie und Referenz gehören zur selben aktiven Sitzung; Fremdsitzung und Widerruf werden abgewiesen',()=>{
 const {db,binding,now,advance}=fixture();
 try{
  const original=makeCookie(now()+60_000,'original'),other=makeCookie(now()+60_000,'other');
  const ref=binding.issue(original),otherRef=binding.issue(other);
  assert.equal(binding.matchesCookie(ref,original),true);
  assert.equal(binding.matchesCookie(ref,other),false);
  assert.equal(binding.matchesCookie(otherRef,original),false);
  assert.equal(binding.matchesCookie('invalid',original),false);
  assert.equal(binding.matchesCookie(ref,original+'x'),false);
  assert.equal(binding.matchesCookie(ref,''),false);
  revokeSession(db,secret,original,now());
  assert.equal(binding.matchesCookie(ref,original),false);
  assert.equal(binding.matchesCookie(ref,other),false);
  assert.equal(binding.matchesCookie(otherRef,other),true);
  advance(60_001);
  assert.equal(binding.matchesCookie(otherRef,other),false);
  advance(-120_000);
  assert.equal(binding.matchesCookie(otherRef,other),false,'beobachtener Ablauf bleibt auch nach Uhrkorrektur bestehen');
 }finally{db.close();}
});

test('verfälschte, abgelaufene oder widerrufene Cookies und ungültige Referenzen scheitern geschlossen',()=>{
 const {db,binding,now}=fixture();
 try {
  const valid=makeCookie(now()+1000),expired=makeCookie(now()-1),bad=valid.slice(0,-1)+(valid.endsWith('A')?'B':'A');
  assert.equal(binding.issue(expired),null);
  assert.equal(binding.issue(bad),null);
  assert.equal(binding.issue(''),null);
  assert.equal(binding.isActive('not-a-reference'),false);
  const ref=binding.issue(valid);
  assert.equal(binding.isActive(ref),true);
  revokeSession(db,secret,valid,now());
  assert.equal(binding.issue(valid),null);
  assert.equal(binding.isActive(ref),false);
 } finally {db.close();}
});

test('fehlendes Widerrufsschema erzeugt keine Referenz und wird nicht implizit angelegt',()=>{
 const db=new Database(':memory:');
 try{
  initializeOidcSessionBindings(db);
  const cookie=makeCookie(Date.now()+60_000);
  const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
  assert.throws(()=>binding.issue(cookie),/no such table/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_session_revocations'").get(),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings').get().n,0);
 }finally{db.close();}
});

test('Ablauf bleibt nach beobachteter Uhrkorrektur zurück ungültig',()=>{
 const {db,binding,now,advance}=fixture();
 try {
  const ref=binding.issue(makeCookie(now()+1000));
  advance(1001);assert.equal(binding.isActive(ref),false);
  advance(-5000);assert.equal(binding.isActive(ref),false);
 } finally {db.close();}
});

test('Referenzen bleiben begrenzt und abgelaufene oder widerrufene Einträge werden sicher freigegeben',()=>{
 const {db,binding,now,advance}=fixture();
 try {
  const cookie=makeCookie(now()+1000);
  const refs=Array.from({length:16},()=>binding.issue(cookie));
  assert.throws(()=>binding.issue(cookie),/Zu viele/);
  assert.equal(binding.resetForCookie('forged'),false);
  assert.equal(binding.isActive(refs[0]),true);
  assert.equal(binding.resetForCookie(cookie),true);
  assert.equal(binding.isActive(refs[0]),false);
  assert.ok(binding.issue(cookie));
  advance(1001);
  const fresh=binding.issue(makeCookie(now()+1000,'fresh'));
  assert.ok(fresh);assert.equal(binding.isActive(refs[0]),false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings').get().n,1);
  const other=makeCookie(now()+1000,'other');binding.issue(other);
  revokeSession(db,secret,other,now());
  assert.ok(binding.issue(makeCookie(now()+1000,'last')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings').get().n,2);
 } finally {db.close();}
});

test('Reset betrifft alle Referenzen genau einer Video-Maker-Sitzung, nicht andere Sitzungen',()=>{
 const {db,binding,now}=fixture();
 try{
  const first=makeCookie(now()+60_000,'first'),second=makeCookie(now()+60_000,'second');
  const firstA=binding.issue(first),firstB=binding.issue(first),other=binding.issue(second);
  assert.equal(binding.resetForCookie(first),true);
  assert.equal(binding.isActive(firstA),false);
  assert.equal(binding.isActive(firstB),false);
  assert.equal(binding.isActive(other),true);
 }finally{db.close();}
});

test('Schlüsselrotation einschließlich A→B→A entwertet alte Referenzen dauerhaft und über Neustart',()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-key-rotation-')),filename=join(directory,'test.sqlite');
 let db=new Database(filename),key=secret,clock=1_800_000_000_000;
 const secretB='another-isolated-secret-at-least-32-characters';
 const cookieFor=(current)=>{const body=`${clock+60_000}.synthetic`;return `${body}.${signSessionBody(body,current)}`;};
 try{
  sessionRevoked(db,key,'seed');initializeOidcSessionBindings(db);
  let binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,key,clock),()=>clock,()=>key);
  const oldA=binding.issue(cookieFor(key));assert.equal(binding.isActive(oldA),true);
  key=secretB;assert.equal(binding.isActive(oldA),false);
  const refB=binding.issue(cookieFor(key));assert.equal(binding.isActive(refB),true);
  key=secret;assert.equal(binding.isActive(oldA),false);assert.equal(binding.isActive(refB),false);
  const newA=binding.issue(cookieFor(key));assert.equal(binding.isActive(newA),true);
  assert.equal(db.serialize().includes(Buffer.from(secret)),false);
  assert.equal(db.serialize().includes(Buffer.from(secretB)),false);
  db.close();db=new Database(filename);
  binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,key,clock),()=>clock,()=>key);
  assert.equal(binding.isActive(oldA),false);assert.equal(binding.isActive(refB),false);assert.equal(binding.isActive(newA),true);
  key=undefined;assert.throws(()=>binding.isActive(newA),/schlüssel/i);assert.throws(()=>binding.issue(cookieFor(secret)),/schlüssel/i);
  key='short';assert.throws(()=>binding.isActive(newA),/schlüssel/i);
 }finally{if(db.open)db.close();rmSync(directory,{recursive:true,force:true});}
});

test('beobachtete Rotation bleibt auch bei späterem Prüffehler dauerhaft erhalten',()=>{
 const db=new Database(':memory:');let key=secret,fail=false;
 const secretB='another-isolated-secret-at-least-32-characters';
 try{
  sessionRevoked(db,key,'seed');initializeOidcSessionBindings(db);
  const binding=createOidcSessionBindings(db,(database,value)=>{
   if(fail)throw new Error('simulierter Prüfungsfehler');
   return verifiedSessionBindingProof(database,value,key);
  },Date.now,()=>key);
  const ref=binding.issue(makeCookie(Date.now()+60_000));
  key=secretB;fail=true;
  assert.throws(()=>binding.issue(makeCookie(Date.now()+60_000)),/simulierter/);
  key=secret;fail=false;
  assert.equal(binding.isActive(ref),false);
  assert.throws(()=>db.transaction(()=>binding.isActive(ref)).immediate(),/eigene Transaktion/);
 }finally{db.close();}
});

test('selbst eine ungültige Referenz beobachtet eine konfigurierte Schlüsselrotation',()=>{
 const db=new Database(':memory:');let key=secret;
 try{
  sessionRevoked(db,key,'seed');initializeOidcSessionBindings(db);
  const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,key),Date.now,()=>key);
  const ref=binding.issue(makeCookie(Date.now()+60_000));
  key='another-isolated-secret-at-least-32-characters';
  assert.equal(binding.isActive('invalid'),false);
  key=secret;assert.equal(binding.isActive(ref),false);
 }finally{db.close();}
});

test('ein administrativer separater Neustart kann Schlüsselgeneration vor Nutzerverkehr beobachten',()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-observe-key-'));
 const filename=join(directory,'videomaker.sqlite'),db=new Database(filename);
 const keyB='another-isolated-secret-at-least-32-characters';
 try{
  sessionRevoked(db,secret,'seed');initializeOidcSessionBindings(db);
  const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
  const ref=binding.issue(makeCookie(Date.now()+60_000));
  const script=new URL('../scripts/oidc-observe-session-key.mjs',import.meta.url);
  const result=spawnSync(process.execPath,['--experimental-strip-types',script.pathname],{encoding:'utf8',env:{...process.env,DATA_DIR:directory,SESSION_SECRET:keyB,OIDC_BINDING_OBSERVE_KEY:'1'}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.includes(keyB),false);
  assert.equal(binding.isActive(ref),false);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('explizites Upgrade entwertet alte Referenzen ohne Schlüsselgeneration',()=>{
 const db=new Database(':memory:');
 try{
  sessionRevoked(db,secret,'seed');
  db.exec('CREATE TABLE oidc_session_bindings(reference_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,expires_at INTEGER NOT NULL)');
  const cookie=makeCookie(Date.now()+60_000),reference='a'.repeat(43),proof=verifiedSessionBindingProof(db,cookie,secret);
  db.prepare('INSERT INTO oidc_session_bindings VALUES(?,?,?)').run(createHash('sha256').update(reference).digest('hex'),proof.sessionHash,proof.expiresAt);
  initializeOidcSessionBindings(db);
  const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
  assert.equal(binding.isActive(reference),false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oidc_session_bindings').get().n,1);
 }finally{db.close();}
});

test('zwei Prozesse mit verschiedenen Schlüsselgenerationen können alte Referenzen nicht wiederbeleben',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-key-race-'));
 const filename=join(directory,'fixture.sqlite'),db=new Database(filename),workers=[];
 const keyB='another-isolated-secret-at-least-32-characters';
 try{
  sessionRevoked(db,secret,'seed');initializeOidcSessionBindings(db);
  const cookie=makeCookie(Date.now()+60_000),binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
  const reference=binding.issue(cookie),script=new URL('./fixtures/oidc-binding-worker.mjs',import.meta.url);
  for(const key of [secret,keyB])workers.push(fork(script,[filename,cookie,'check',key,reference],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));} )));
  const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(new Error('Testprozess fehlgeschlagen'));});}));
  for(const w of workers)w.send('go');
  const checks=await Promise.all(results);assert.ok(checks.every(row=>row.operation==='check'));
  assert.equal(checks[1].active,false);
  assert.equal(binding.isActive(reference),false);
 }finally{for(const w of workers)if(w.connected)w.disconnect();db.close();rmSync(directory,{recursive:true,force:true});}
});

test('Logout und Erzeugen einer Referenz in zwei Prozessen lassen keine aktive widerrufene Sitzung zurück',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-binding-race-'));
 const filename=join(directory,'fixture.sqlite'),db=new Database(filename),workers=[];
 try {
  sessionRevoked(db,secret,'seed');initializeOidcSessionBindings(db);
  const cookie=makeCookie(Date.now()+60_000),script=new URL('./fixtures/oidc-binding-worker.mjs',import.meta.url);
  for(const op of ['issue','logout'])workers.push(fork(script,[filename,cookie,op],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));} )));
  const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(new Error('Testprozess fehlgeschlagen'));});}));
  for(const w of workers)w.send('go');
  const messages=await Promise.all(results);
  assert.ok(messages.some(m=>m.operation==='logout'));
  const issued=messages.find(m=>m.operation==='issue');assert.ok(issued);
  const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
  if(issued.reference)assert.equal(binding.isActive(issued.reference),false);
  assert.equal(binding.issue(cookie),null);
 } finally {for(const w of workers)if(w.connected)w.disconnect();db.close();rmSync(directory,{recursive:true,force:true});}
});
