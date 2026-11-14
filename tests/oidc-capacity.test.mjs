import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {initializeOidcStorage} from '../lib/oidc-storage.ts';
import {initializeOidcProviderSessionMap} from '../lib/oidc-provider-session-map.ts';
import {initializeOidcSessionBindings} from '../lib/oidc-session-bindings.ts';
import {measureOidcProviderCapacity,measureOidcBindingCapacity} from '../lib/oidc-capacity.ts';

const roomy={warn:100,critical:200}, bytes={warn:1_000_000,critical:2_000_000};
const providerLimits=()=>({oidc_records:{...roomy},oidc_consumed_objects:{warn:1,critical:2},oidc_revoked_grants:{...roomy},oidc_provider_session_map:{...roomy},databaseBytes:{...bytes}});
const bindingLimits=()=>({oidc_session_bindings:{...roomy},auth_session_revocations:{warn:1,critical:2},databaseBytes:{...bytes}});

test('Provider-Kapazität meldet Warn- und Kritischgrenze ohne Inhalte oder Änderungen',()=>{
 const db=new Database(':memory:');
 try{
  initializeOidcStorage(db);initializeOidcProviderSessionMap(db);
  const limits=providerLimits();
  assert.equal(measureOidcProviderCapacity(db,limits).status,'ok');
  db.prepare('INSERT INTO oidc_consumed_objects(model,id) VALUES(?,?)').run('Code','privater-testwert');
  const before=db.serialize(),warning=measureOidcProviderCapacity(db,limits);
  assert.deepEqual(warning.exceeded,[{metric:'oidc_consumed_objects',level:'warning'}]);
  assert.equal(warning.counts.oidc_consumed_objects,1);
  assert.equal(warning.status,'warning');
  assert.equal(JSON.stringify(warning).includes('privater-testwert'),false);
  assert.deepEqual(db.serialize(),before);
  db.prepare('INSERT INTO oidc_consumed_objects(model,id) VALUES(?,?)').run('Code','privater-testwert-2');
  const critical=measureOidcProviderCapacity(db,limits);
  assert.equal(critical.status,'critical');
  assert.deepEqual(critical.exceeded,[{metric:'oidc_consumed_objects',level:'critical'}]);
  assert.ok(critical.databaseBytes>0);
  const spaceLimits=providerLimits();
  spaceLimits.oidc_consumed_objects={...roomy};
  spaceLimits.databaseBytes={warn:1,critical:critical.databaseBytes};
  assert.ok(measureOidcProviderCapacity(db,spaceLimits).exceeded.some(item=>item.metric==='databaseBytes'&&item.level==='critical'));
 }finally{db.close();}
});

test('Separate Sitzungsdatenbank zählt Bindungen und Widerrufe ohne Bereinigung',()=>{
 const db=new Database(':memory:');
 try{
  initializeOidcSessionBindings(db);
  db.exec('CREATE TABLE auth_session_revocations(session_hash TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO auth_session_revocations VALUES(?,?)').run('synthetischer-hash',1);
  const before=db.serialize(),result=measureOidcBindingCapacity(db,bindingLimits());
  assert.equal(result.status,'warning');
  assert.equal(result.counts.auth_session_revocations,1);
  assert.equal(result.counts.oidc_session_bindings,0);
  assert.deepEqual(db.serialize(),before);
 }finally{db.close();}
});

test('Fehlendes Schema und unvollständige oder ungültige Grenzwerte schlagen fehl',()=>{
 const db=new Database(':memory:');
 try{
  assert.throws(()=>measureOidcProviderCapacity(db,providerLimits()),/no such table/);
  initializeOidcStorage(db);initializeOidcProviderSessionMap(db);
  const missing=providerLimits();delete missing.oidc_records;
  assert.throws(()=>measureOidcProviderCapacity(db,missing),/Kapazitätsgrenzen/);
  for(const bad of [{warn:0,critical:1},{warn:2,critical:2},{warn:Infinity,critical:5},{warn:1.5,critical:2}]){
   const invalid=providerLimits();invalid.databaseBytes=bad;
   assert.throws(()=>measureOidcProviderCapacity(db,invalid),/Kapazitätsgrenzen/);
  }
 }finally{db.close();}
});
