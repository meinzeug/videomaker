import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createStudioDeviceAuth,initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';

const owner='a'.repeat(64), secret=Buffer.alloc(32,17), ok=()=>true;
function fixture(){
 const db=new Database(':memory:');initializeStudioDeviceAuth(db);let now=1_000_000;
 const api=createStudioDeviceAuth(db,()=>now,secret), keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const publicKey=keys.publicKey.export({format:'der',type:'spki'}),device=randomUUID();
 const signature=challenge=>sign('sha256',challenge.message,keys.privateKey);
 const enroll=()=>{const c=api.beginEnrollment(device,publicKey,['projects:read'],owner,ok);assert.ok(c);assert.deepEqual(api.completeEnrollment(device,c.challengeId,signature(c),owner,ok),{enrolled:true});};
 const login=()=>{const c=api.beginLogin(device);assert.ok(c);const value=api.completeLogin(device,c.challengeToken,signature(c));assert.ok(value);return value.ticket;};
 return {db,api,keys,publicKey,device,signature,enroll,login,set:n=>now=n,get:()=>now};
}

test('enrollment is key- and authority-bound; ticket has only explicit capability',()=>{
 const f=fixture();try{f.enroll();const t=f.login();assert.equal(f.api.permits(t,'projects:read'),true);assert.equal(f.api.permits(t,'recordings:upload'),false);assert.equal(f.api.permits(t,'admin'),false);assert.equal(f.db.serialize().includes(Buffer.from(t)),false);}finally{f.db.close();}
});
test('false or throwing authorization cannot enroll or revoke',()=>{
 const f=fixture();try{
 assert.equal(f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,()=>false),null);
 assert.equal(f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,()=>{throw Error();}),null);
 const c=f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,ok);assert.ok(c);
 assert.equal(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,()=>false),null);
 assert.deepEqual(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,ok),{enrolled:true});
 const ticket=f.login();assert.equal(f.api.revoke(f.device,()=>false),false);assert.equal(f.api.permits(ticket,'projects:read'),true);
 }finally{f.db.close();}
});
test('rejects altered owner, substituted key, replay and duplicate key',()=>{
 const f=fixture();try{
 const c=f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,ok), other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 assert.equal(f.api.completeEnrollment(f.device,c.challengeId,sign('sha256',c.message,other.privateKey),owner,ok),null);
 assert.equal(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),'b'.repeat(64),ok),null);
 assert.deepEqual(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,ok),{enrolled:true});
 assert.equal(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,ok),null);
 assert.equal(f.api.beginEnrollment(randomUUID(),f.publicKey,['projects:read'],owner,ok),null);
 const l=f.api.beginLogin(f.device), signed=f.signature(l);assert.ok(f.api.completeLogin(f.device,l.challengeToken,signed));assert.equal(f.api.completeLogin(f.device,l.challengeToken,signed),null);
 }finally{f.db.close();}
});
test('expired challenge and ticket cannot revive after clock rollback',()=>{
 const f=fixture();try{
 f.enroll();const c=f.api.beginLogin(f.device);f.set(f.get()+60_000);assert.equal(f.api.completeLogin(f.device,c.challengeToken,f.signature(c)),null);
 f.set(f.get()-50_000);assert.equal(f.api.completeLogin(f.device,c.challengeToken,f.signature(c)),null);
 f.set(1_060_001);const t=f.login();f.set(f.get()+300_000);assert.equal(f.api.permits(t,'projects:read'),false);
 f.set(f.get()-100_000);assert.equal(f.api.permits(t,'projects:read'),false);
 }finally{f.db.close();}
});
test('revocation invalidates old ticket and challenge and forbids re-enrollment',()=>{
 const f=fixture();try{
 f.enroll();const t=f.login(),challenge=f.api.beginLogin(f.device);assert.equal(f.api.revoke(f.device,ok),true);
 assert.equal(f.api.permits(t,'projects:read'),false);assert.equal(f.api.completeLogin(f.device,challenge.challengeToken,f.signature(challenge)),null);
 assert.equal(f.api.beginLogin(f.device),null);assert.equal(f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,ok),null);
 }finally{f.db.close();}
});
test('scope rejects unknown, duplicate and empty capabilities',()=>{
 for(const scope of [[],['admin'],['projects:read','projects:read']]){const f=fixture();try{assert.throws(()=>f.api.beginEnrollment(f.device,f.publicKey,scope,owner,ok));assert.equal(f.db.prepare('SELECT count(*) n FROM studio_auth_devices').get().n,0);}finally{f.db.close();}}
});
test('late authority loss and elapsed time during completion fail closed',()=>{
 const f=fixture();try{
 const c=f.api.beginEnrollment(f.device,f.publicKey,['projects:read'],owner,ok);let calls=0;
 const expires=()=>{calls++;if(calls===3)f.set(f.get()+60_000);return true;};
 assert.equal(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,expires),null);
 f.set(f.get()-50_000);assert.equal(f.api.completeEnrollment(f.device,c.challengeId,f.signature(c),owner,ok),null);
 }finally{f.db.close();}
});
test('outstanding tickets and challenges are bounded',()=>{
 const f=fixture();try{
 f.enroll();for(let i=0;i<8;i++)f.login();const c=f.api.beginLogin(f.device);assert.ok(c);assert.equal(f.api.completeLogin(f.device,c.challengeToken,f.signature(c)),null);
 assert.ok(f.api.beginLogin(f.device));f.set(f.get()+300_000);assert.ok(f.login());
 }finally{f.db.close();}
});

test('persisted expiry floor survives a database reopen', async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'studio-device-clock-'));let db;
 try{
  const f=fixture();f.enroll();const t=f.login();f.set(f.get()+300_000);assert.equal(f.api.permits(t,'projects:read'),false);
  const file=join(dir,'fixture.sqlite');await f.db.backup(file);f.db.close();
  db=new Database(file);assert.equal(createStudioDeviceAuth(db,()=>1_000_100,secret).permits(t,'projects:read'),false);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('two processes racing the same signed login can issue only one ticket',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fork}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'studio-device-race-'));const file=join(dir,'fixture.sqlite');let db;const children=[];
 try{
  db=new Database(file);initializeStudioDeviceAuth(db);const api=createStudioDeviceAuth(db,()=>1_000_000,secret);
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),device=randomUUID();
  const c=api.beginEnrollment(device,keys.publicKey.export({format:'der',type:'spki'}),['projects:read'],owner,ok);
  assert.ok(api.completeEnrollment(device,c.challengeId,sign('sha256',c.message,keys.privateKey),owner,ok));
  const login=api.beginLogin(device), sig=sign('sha256',login.message,keys.privateKey).toString('base64');db.close();db=null;
  const worker=new URL('./fixtures/studio-device-auth-race.mjs',import.meta.url);
  const ready=()=>new Promise((resolve,reject)=>{
   const child=fork(worker,[file,device,login.challengeToken,sig],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);
   child.once('error',reject);child.once('message',msg=>msg==='ready'?resolve(child):reject(Error('fixture failed')));
  });
  const [a,b]=await Promise.all([ready(),ready()]);
  const result=child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.send('go');});
  const results=await Promise.all([result(a),result(b)]);
  assert.deepEqual(results.map(v=>v.accepted).sort(),[false,true]);
  db=new Database(file);assert.equal(db.prepare('SELECT count(*) n FROM studio_auth_tickets').get().n,1);
 }finally{for(const c of children)if(c.connected)c.kill();db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('unauthenticated challenge flood reserves no slots and cannot block valid login',()=>{
 const f=fixture();try{
  f.enroll();const before=f.db.serialize();const forged=[];
  for(let i=0;i<1000;i++){const c=f.api.beginLogin(f.device);assert.ok(c);if(i<2)forged.push(c);}
  assert.deepEqual(f.db.serialize(),before);
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  for(const c of forged)assert.equal(f.api.completeLogin(f.device,c.challengeToken,sign('sha256',c.message,other.privateKey)),null);
  assert.deepEqual(f.db.serialize(),before);
  const valid=f.login();assert.equal(f.api.permits(valid,'projects:read'),true);
 }finally{f.db.close();}
});

test('MAC substitution, cross-device reuse and key rotation fail',()=>{
 const f=fixture();try{
  f.enroll();const c=f.api.beginLogin(f.device), sig=f.signature(c), parts=c.challengeToken.split('.');
  parts[1]=String(Number(parts[1])+1);
  assert.equal(f.api.completeLogin(f.device,parts.join('.'),sig),null);
  assert.equal(f.api.completeLogin(randomUUID(),c.challengeToken,sig),null);
  const rotated=createStudioDeviceAuth(f.db,f.get,Buffer.alloc(32,18));
  assert.equal(rotated.completeLogin(f.device,c.challengeToken,sig),null);
  assert.ok(f.api.completeLogin(f.device,c.challengeToken,sig));
 }finally{f.db.close();}
});

test('revocation between proof verification and commit prevents issuance',()=>{
 const f=fixture();try{
  f.enroll();const c=f.api.beginLogin(f.device);let calls=0;
  const racy=createStudioDeviceAuth(f.db,()=>{if(++calls===1)f.db.prepare('UPDATE studio_auth_devices SET revoked=1 WHERE device_id=?').run(f.device);return f.get();},secret);
  assert.equal(racy.completeLogin(f.device,c.challengeToken,f.signature(c)),null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_auth_tickets').get().n,0);
 }finally{f.db.close();}
});

test('random unknown ticket is rejected without acquiring a writer lock',()=>{
 const f=fixture();try{
  f.db.pragma('query_only = ON');
  assert.equal(f.api.permits('A'.repeat(43),'projects:read'),false);
 }finally{f.db.pragma('query_only = OFF');f.db.close();}
});

test('observed future in beginLogin must not allow a previous challenge after wall rollback',()=>{
 const f=fixture();try{
  f.enroll();const first=f.api.beginLogin(f.device),sig=f.signature(first);
  f.set(f.get()+60_001);assert.ok(f.api.beginLogin(f.device));
  f.set(f.get()-60_000);
  assert.equal(f.api.completeLogin(f.device,first.challengeToken,sig),null);
 }finally{f.db.close();}
});

test('observed future on one connection fences rollback on another and after reopen',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'studio-auth-cross-clock-'));let left,right;
 try{
  const f=fixture();f.enroll();const c=f.api.beginLogin(f.device),signature=f.signature(c);
  const file=join(dir,'fixture.sqlite');await f.db.backup(file);f.db.close();
  left=new Database(file);right=new Database(file);
  assert.ok(createStudioDeviceAuth(left,()=>1_060_001,secret).beginLogin(f.device));
  assert.equal(createStudioDeviceAuth(right,()=>1_000_001,secret).completeLogin(f.device,c.challengeToken,signature),null);
  left.close();left=null;right.close();right=null;
  right=new Database(file);assert.equal(createStudioDeviceAuth(right,()=>1_000_001,secret).completeLogin(f.device,c.challengeToken,signature),null);
 }finally{left?.close();right?.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown device challenge is rejected without writer lock',()=>{
 const f=fixture();try{f.db.pragma('query_only = ON');assert.equal(f.api.beginLogin(randomUUID()),null);}
 finally{f.db.pragma('query_only = OFF');f.db.close();}
});
