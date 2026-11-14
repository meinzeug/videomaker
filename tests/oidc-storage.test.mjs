import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import Database from 'better-sqlite3';
import { createOidcStorageAdapter, initializeOidcStorage } from '../lib/oidc-storage.ts';

function fixture() {
 const db = new Database(':memory:');
 initializeOidcStorage(db);
 let time = 1_800_000_000_000;
 const Adapter = createOidcStorageAdapter(db, () => time);
 return { db, Adapter, advance: (amount) => { time += amount; } };
}

test('Adapter trennt Modelle, erhält Nutzdaten und verwirft abgelaufene Einträge', async () => {
 const {db,Adapter,advance}=fixture();
 try {
  const code=new Adapter('AuthorizationCode'), session=new Adapter('Session');
  await code.upsert('gleiche-id',{sub:'person',grantId:'grant-1'},3);
  await session.upsert('gleiche-id',{uid:'session-uid',accountId:'person'},10);
  assert.deepEqual(await code.find('gleiche-id'),{sub:'person',grantId:'grant-1'});
  assert.equal((await session.findByUid('session-uid')).accountId,'person');
  advance(3000);
  assert.equal(await code.find('gleiche-id'),undefined);
  assert.equal((await session.find('gleiche-id')).uid,'session-uid');
  await session.destroy('gleiche-id');
  assert.equal(await session.findByUid('session-uid'),undefined);
 } finally { db.close(); }
});

test('ein Code kann genau einmal verbraucht und durch erneutes Speichern nicht reaktiviert werden', async () => {
 const {db,Adapter}=fixture();
 try {
  const code=new Adapter('AuthorizationCode');
  await code.upsert('code-1',{grantId:'grant-1'},30);
  const attempts=await Promise.allSettled([code.consume('code-1'),code.consume('code-1')]);
  assert.deepEqual(attempts.map((entry)=>entry.status).sort(),['fulfilled','rejected']);
  const used=(await code.find('code-1')).consumed;
  assert.equal(typeof used,'number');
  await code.upsert('code-1',{grantId:'grant-1'},30);
  assert.equal((await code.find('code-1')).consumed,used);
  await assert.rejects(code.consume('code-1'));
  await code.destroy('code-1');
  await assert.rejects(code.upsert('code-1',{grantId:'grant-2'},30));
 } finally { db.close(); }
});

test('Widerruf entfernt abhängige Tokens und verhindert späteres Wiederanlegen', async () => {
 const {db,Adapter}=fixture();
 try {
  const grant=new Adapter('Grant'), code=new Adapter('AuthorizationCode'), token=new Adapter('AccessToken');
  await grant.upsert('grant-1',{accountId:'person'},30);
  await code.upsert('code-1',{grantId:'grant-1'},30);
  await token.upsert('token-1',{grantId:'grant-1'},30);
  await token.upsert('token-2',{grantId:'grant-2'},30);
  await code.revokeByGrantId('grant-1');
  assert.equal(await grant.find('grant-1'),undefined);
  assert.equal(await code.find('code-1'),undefined);
  assert.equal(await token.find('token-1'),undefined);
  assert.equal((await token.find('token-2')).grantId,'grant-2');
  await assert.rejects(code.upsert('code-2',{grantId:'grant-1'},30));
  await assert.rejects(code.upsert('code-1',{grantId:'grant-2'},30));
  await assert.rejects(token.upsert('token-1',{grantId:'grant-2'},30));
  await assert.rejects(grant.upsert('grant-1',{accountId:'person'},30));
 } finally { db.close(); }
});

test('bestehende Grant-Zuordnung ist unveränderlich; nur vorgesehene Modelle erhalten sie nachträglich', async () => {
 const {db,Adapter}=fixture();
 try {
  const code=new Adapter('AuthorizationCode');
  await code.upsert('code',{grantId:'grant-a'},60);
  await assert.rejects(code.upsert('code',{grantId:'grant-b'},60));
  await assert.rejects(code.upsert('code',{},60));
  await code.upsert('code',{grantId:'grant-a'},60);
  await code.revokeByGrantId('grant-a');
  assert.equal(await code.find('code'),undefined);
  await code.upsert('unbound',{},60);
  await assert.rejects(code.upsert('unbound',{grantId:'grant-b'},60));
  for(const model of ['DeviceCode','BackchannelAuthenticationRequest']) {
   const item=new Adapter(model);
   await item.upsert('id',{},60);
   await item.upsert('id',{grantId:'grant-b'},60);
   await assert.rejects(item.upsert('id',{grantId:'grant-c'},60));
   await assert.rejects(item.upsert('id',{},60));
   await item.upsert('late',{},60);
   await item.revokeByGrantId('revoked');
   await assert.rejects(item.upsert('late',{grantId:'revoked'},60));
  }
 } finally { db.close(); }
});

test('ungültige Laufzeiten, fehlende Objekte und doppelte alternative Kennungen scheitern', async () => {
 const {db,Adapter,advance}=fixture();
 try {
  const session=new Adapter('Session');
  await assert.rejects(session.upsert('bad',{},-1));
  await assert.rejects(session.upsert('bad',{},Infinity));
  await assert.rejects(session.consume('missing'));
  await session.upsert('a',{uid:'uid'},1);
  await assert.rejects(session.upsert('b',{uid:'uid'},1));
  advance(1000);
  await assert.rejects(session.consume('a'));
 } finally { db.close(); }
});

test('abgelaufene sekundäre Kennungen sind erneut nutzbar, ohne alte Objekte wiederzubeleben', async () => {
 const {db,Adapter,advance}=fixture();
 try {
  const session=new Adapter('Session'), device=new Adapter('DeviceCode');
  await session.upsert('old-session',{uid:'uid-1'},1);
  await device.upsert('old-device',{userCode:'ABCD1234'},1);
  await assert.rejects(session.upsert('new-session',{uid:'uid-1'},60));
  await assert.rejects(device.upsert('new-device',{userCode:'ABCD1234'},60));
  advance(1000);
  await session.upsert('new-session',{uid:'uid-1'},60);
  await device.upsert('new-device',{userCode:'ABCD1234'},60);
  assert.equal(await session.find('old-session'),undefined);
  assert.equal(await device.find('old-device'),undefined);
  assert.equal((await session.findByUid('uid-1')).uid,'uid-1');
  assert.equal((await device.findByUserCode('ABCD1234')).userCode,'ABCD1234');
  advance(-2000);
  assert.equal(await session.find('old-session'),undefined);
  assert.equal(await device.find('old-device'),undefined);
  await assert.rejects(session.upsert('old-session',{uid:'uid-1'},60));
  await assert.rejects(device.upsert('old-device',{userCode:'ABCD1234'},60));
 } finally { db.close(); }
});

test('beobachteter Ablauf bleibt auch nach rückwärts gestellter Uhr ungültig', async () => {
 const {db,Adapter,advance}=fixture();
 try {
  const code=new Adapter('AuthorizationCode');
  await code.upsert('code',{grantId:'grant'},1);
  advance(1500);
  await assert.rejects(code.consume('code'));
  advance(-3000);
  assert.equal(await code.find('code'),undefined);
  await assert.rejects(code.upsert('code',{grantId:'grant'},30));
 } finally { db.close(); }
});

test('gelöschte und abgelaufene Objekte lassen sich auch nach Neustart nicht wiederbeleben', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-destroy-'));
 const filename=join(directory,'test.sqlite');
 let db=new Database(filename), time=1_800_000_000_000;
 try {
  initializeOidcStorage(db);
  let Adapter=createOidcStorageAdapter(db,()=>time);
  const token=new Adapter('AccessToken'), code=new Adapter('AuthorizationCode');
  await token.upsert('token',{grantId:'grant'},60);
  await token.destroy('token');
  await code.upsert('expired',{grantId:'grant'},1);
  time+=2000;
  assert.equal(await code.find('expired'),undefined);
  await code.destroy('expired');
  await code.destroy('missing');
  db.close();
  db=new Database(filename);time-=3000;
  Adapter=createOidcStorageAdapter(db,()=>time);
  await assert.rejects(new Adapter('AccessToken').upsert('token',{grantId:'grant'},60));
  await assert.rejects(new Adapter('AuthorizationCode').upsert('expired',{grantId:'grant'},60));
  await assert.rejects(new Adapter('AuthorizationCode').upsert('missing',{grantId:'grant'},60));
  assert.equal(await new Adapter('AccessToken').find('token'),undefined);
  assert.equal(await new Adapter('AuthorizationCode').find('expired'),undefined);
  await new Adapter('AccessToken').upsert('missing',{grantId:'grant'},60);
 } finally { if(db.open)db.close();rmSync(directory,{recursive:true,force:true}); }
});

test('Verbrauch und Widerruf bleiben nach Schließen und Wiederöffnen der separaten Datenbank erhalten', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-storage-'));
 const filename=join(directory,'test.sqlite');
 let db=new Database(filename);
 try {
  initializeOidcStorage(db);
  let Adapter=createOidcStorageAdapter(db);
  let code=new Adapter('AuthorizationCode');
  await code.upsert('code-dauerhaft',{grantId:'grant-dauerhaft'},60);
  await code.consume('code-dauerhaft');
  db.close();
  db=new Database(filename);
  Adapter=createOidcStorageAdapter(db);
  code=new Adapter('AuthorizationCode');
  assert.equal(typeof (await code.find('code-dauerhaft')).consumed,'number');
  await assert.rejects(code.consume('code-dauerhaft'));
  await code.revokeByGrantId('grant-dauerhaft');
  db.close();
  db=new Database(filename);
  Adapter=createOidcStorageAdapter(db);
  code=new Adapter('AuthorizationCode');
  assert.equal(await code.find('code-dauerhaft'),undefined);
  await assert.rejects(code.upsert('anderer-code',{grantId:'grant-dauerhaft'},60));
  await assert.rejects(code.upsert('code-dauerhaft',{grantId:'anderes-grant'},60));
 } finally { if (db.open) db.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('zwei unabhängige Prozesse können denselben Code nicht gleichzeitig verbrauchen', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-race-'));
 const filename=join(directory,'test.sqlite');
 const db=new Database(filename);
 const workers=[];
 try {
  initializeOidcStorage(db);
  const Adapter=createOidcStorageAdapter(db);
  await new Adapter('AuthorizationCode').upsert('parallel-code',{grantId:'grant'},60);
  const script=new URL('./fixtures/oidc-consume-worker.mjs',import.meta.url);
  for (let i=0;i<2;i++) workers.push(fork(script,[filename],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map((worker)=>new Promise((resolve,reject)=>{
   worker.once('error',reject);
   worker.once('message',(message)=>message==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));
  })));
  const results=workers.map((worker)=>new Promise((resolve,reject)=>{
   worker.once('error',reject);
   worker.once('message',resolve);
   worker.once('exit',(code)=>{ if(code!==0) reject(new Error(`Testprozess beendet: ${code}`)); });
  }));
  for(const worker of workers) worker.send('go');
  assert.deepEqual((await Promise.all(results)).sort(),['consumed','rejected']);
 } finally {
  for(const worker of workers) if(worker.connected) worker.disconnect();
  db.close();
  rmSync(directory,{recursive:true,force:true});
 }
});

test('gleichzeitiges Löschen und Speichern kann in zwei Prozessen nicht wiederbeleben', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-destroy-race-'));
 const filename=join(directory,'test.sqlite');
 const db=new Database(filename);
 const workers=[];
 try {
  initializeOidcStorage(db);
  const Adapter=createOidcStorageAdapter(db);
  await new Adapter('AuthorizationCode').upsert('parallel-code',{grantId:'grant'},60);
  const script=new URL('./fixtures/oidc-consume-worker.mjs',import.meta.url);
  for(const operation of ['destroy','upsert']) workers.push(fork(script,[filename,operation],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',message=>message==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));
  })));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',resolve);
   worker.once('exit',code=>{if(code!==0)reject(new Error(`Testprozess beendet: ${code}`));});
  }));
  for(const worker of workers)worker.send('go');
  const outcomes=await Promise.all(results);
  assert.ok(outcomes.includes('destroyed'));
  assert.ok(outcomes.includes('saved')||outcomes.includes('rejected'));
  const code=new Adapter('AuthorizationCode');
  assert.equal(await code.find('parallel-code'),undefined);
  await assert.rejects(code.upsert('parallel-code',{grantId:'grant'},60));
 } finally {
  for(const worker of workers)if(worker.connected)worker.disconnect();
  db.close();rmSync(directory,{recursive:true,force:true});
 }
});

test('gleichzeitiger Grant-Widerruf und Speichern kann in zwei Prozessen nicht wiederbeleben', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-revoke-race-'));
 const filename=join(directory,'test.sqlite');
 const db=new Database(filename);
 const workers=[];
 try {
  initializeOidcStorage(db);
  const Adapter=createOidcStorageAdapter(db);
  await new Adapter('AuthorizationCode').upsert('parallel-code',{grantId:'grant'},60);
  const script=new URL('./fixtures/oidc-consume-worker.mjs',import.meta.url);
  for(const operation of ['revoke','upsert']) workers.push(fork(script,[filename,operation],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',message=>message==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));
  })));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',resolve);
   worker.once('exit',code=>{if(code!==0)reject(new Error(`Testprozess beendet: ${code}`));});
  }));
  for(const worker of workers)worker.send('go');
  const outcomes=await Promise.all(results);
  assert.ok(outcomes.includes('revoked'));
  assert.ok(outcomes.includes('saved')||outcomes.includes('rejected'));
  const code=new Adapter('AuthorizationCode');
  assert.equal(await code.find('parallel-code'),undefined);
  await assert.rejects(code.upsert('parallel-code',{grantId:'grant'},60));
  await assert.rejects(code.upsert('parallel-code',{grantId:'other-grant'},60));
 } finally {
  for(const worker of workers)if(worker.connected)worker.disconnect();
  db.close();rmSync(directory,{recursive:true,force:true});
 }
});

test('paralleler Grant-Wechsel kann einem gleichzeitigen Widerruf nicht entgehen', async () => {
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-rebind-race-'));
 const filename=join(directory,'test.sqlite');
 const db=new Database(filename), workers=[];
 try {
  initializeOidcStorage(db);
  const Adapter=createOidcStorageAdapter(db), code=new Adapter('AuthorizationCode');
  await code.upsert('parallel-code',{grantId:'grant'},60);
  const script=new URL('./fixtures/oidc-consume-worker.mjs',import.meta.url);
  for(const operation of ['revoke','rebind']) workers.push(fork(script,[filename,operation],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',message=>message==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));
  })));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',resolve);
   worker.once('exit',exitCode=>{if(exitCode!==0)reject(new Error(`Testprozess beendet: ${exitCode}`));});
  }));
  for(const worker of workers)worker.send('go');
  assert.deepEqual((await Promise.all(results)).sort(),['rejected','revoked']);
  assert.equal(await code.find('parallel-code'),undefined);
  await assert.rejects(code.upsert('parallel-code',{grantId:'other-grant'},60));
 } finally {
  for(const worker of workers)if(worker.connected)worker.disconnect();
  db.close();rmSync(directory,{recursive:true,force:true});
 }
});
