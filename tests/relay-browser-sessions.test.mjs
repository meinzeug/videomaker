import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {registerRelayBrowserSession,resolveRelayBrowserSession} from '../lib/relay-browser-sessions.ts';
import {relaySessionId,revokeSession,sessionRevoked} from '../lib/session-revocations.ts';

const secret='fixture-session-secret-at-least-32-characters',owner='a'.repeat(64),other='b'.repeat(64);
function cookie(expires){const body=`${expires}.${randomBytes(18).toString('base64url')}`;return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;}
function fixture(){const db=new Database(':memory:');sessionRevoked(db,secret,'initialize-fixture');return db;}
function resolve(db,account,id,now=()=>1000,key=secret){return db.transaction(()=>resolveRelayBrowserSession(db,key,account,id,now)).immediate();}

test('authenticated cookie is indexed without persisting it; logout and owner are enforced',()=>{
 const db=fixture();try{
  const value=cookie(10000),id=registerRelayBrowserSession(db,secret,value,owner,()=>1000);
  assert.equal(id,relaySessionId(secret,value));assert.equal(resolve(db,owner,id),true);assert.equal(resolve(db,other,id),false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM relay_browser_sessions').get()).includes(value),false);
  assert.equal(registerRelayBrowserSession(db,secret,value,other,()=>1000),null);
  assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>1000),id);
  revokeSession(db,secret,value,1001);assert.equal(resolve(db,owner,id),false);assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>1002),null);
 }finally{db.close();}
});
test('invalid signature, expiry, secret rotation and missing schema fail closed',()=>{
 const db=fixture();try{
  const value=cookie(1100),id=registerRelayBrowserSession(db,secret,value,owner,()=>1000);
  assert.equal(registerRelayBrowserSession(db,secret,value+'x',owner,()=>1000),null);
  assert.equal(resolve(db,owner,id,()=>1000,'different-secret-at-least-32-characters'),false);
  assert.equal(resolve(db,owner,id,()=>1100),false);
  assert.equal(resolve(db,owner,id,()=>1001),false);
  assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>1001),null);
  assert.throws(()=>resolveRelayBrowserSession(db,secret,owner,id,()=>1001),/RELAY_TRANSACTION_REQUIRED/);
  db.exec('DROP TABLE auth_session_revocations');assert.equal(resolve(db,owner,id),false);
 }finally{db.close();}
});
test('expiration during registration persists as a tombstone',()=>{
 const db=fixture();try{
  const value=cookie(1100);let reads=0;
  assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>++reads===1?1000:1100),null);
  assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>1001),null);
 }finally{db.close();}
});
test('row deletion and substitution during clock checks cannot authorize',()=>{
 for(const phase of ['registration-delete','registration-replace','resolution-delete','resolution-replace']){
  const db=fixture();try{
   const value=cookie(10000),id=relaySessionId(secret,value);let reads=0;
   const mutate=()=>{if(++reads===2){if(phase.endsWith('delete'))db.prepare('DELETE FROM relay_browser_sessions WHERE session_hash=?').run(id);else db.prepare('UPDATE relay_browser_sessions SET revocation_hash=? WHERE session_hash=?').run('f'.repeat(64),id);}return 1000;};
   if(phase.startsWith('registration'))assert.equal(registerRelayBrowserSession(db,secret,value,owner,mutate),null);
   else{
    assert.equal(registerRelayBrowserSession(db,secret,value,owner,()=>1000),id);
    reads=1;assert.equal(resolve(db,owner,id,mutate),false);
   }
  }finally{db.close();}
 }
});
test('capacity is bounded and refuses new sessions rather than evicting trust',()=>{
 const db=fixture();try{
  registerRelayBrowserSession(db,secret,cookie(10000),owner,()=>1000);
  const insert=db.prepare('INSERT INTO relay_browser_sessions VALUES(?,?,?,?,?,?)');
  for(let i=0;i<127;i++)insert.run(i.toString(16).padStart(64,'0'),owner,'c'.repeat(64),'d'.repeat(64),10000,0);
  assert.throws(()=>registerRelayBrowserSession(db,secret,cookie(10000),owner,()=>1000),/RELAY_SESSION_CAPACITY/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relay_browser_sessions').get().n,128);
 }finally{db.close();}
});
