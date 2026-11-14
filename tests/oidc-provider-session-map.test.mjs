import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createOidcProviderSessionMap,initializeOidcProviderSessionMap } from '../lib/oidc-provider-session-map.ts';

test('Provider-Sitzung bleibt auch nach Wiederanlauf unveränderlich an eine Referenz gebunden',()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-map-')),filename=join(directory,'test.sqlite');
 let db=new Database(filename);
 try{
  initializeOidcProviderSessionMap(db);
  let map=createOidcProviderSessionMap(db);
  const uid='u'.repeat(43),reference='r'.repeat(43);
  map.bindOnce(uid,reference);map.bindOnce(uid,reference);
  assert.equal(map.find(uid),reference);
  assert.equal(db.serialize().includes(Buffer.from(uid)),false);
  assert.throws(()=>map.bindOnce(uid,'n'.repeat(43)),/bereits anders/);
  assert.throws(()=>map.bindOnce('short',reference),/Ungültige/);
  assert.throws(()=>map.bindOnce(uid,'short'),/Ungültige/);
  db.close();db=new Database(filename);map=createOidcProviderSessionMap(db);
  assert.equal(map.find(uid),reference);
  assert.throws(()=>map.bindOnce(uid,'n'.repeat(43)),/bereits anders/);
 }finally{if(db.open)db.close();rmSync(directory,{recursive:true,force:true});}
});

test('zwei Prozesse können eine Provider-Sitzung nicht verschiedenen Referenzen zuordnen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-oidc-map-race-')),filename=join(directory,'test.sqlite');
 const db=new Database(filename),workers=[];
 try{
  initializeOidcProviderSessionMap(db);
  const script=new URL('./fixtures/oidc-session-map-worker.mjs',import.meta.url);
  for(const reference of ['a'.repeat(43),'b'.repeat(43)])workers.push(fork(script,[filename,reference],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));} )));
  const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(new Error('Testprozess fehlgeschlagen'));});}));
  for(const w of workers)w.send('go');
  assert.deepEqual((await Promise.all(results)).sort(),['bound','rejected']);
  const reference=createOidcProviderSessionMap(db).find('u'.repeat(43));
  assert.ok(['a'.repeat(43),'b'.repeat(43)].includes(reference));
 }finally{for(const w of workers)if(w.connected)w.disconnect();db.close();rmSync(directory,{recursive:true,force:true});}
});
