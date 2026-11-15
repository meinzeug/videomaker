import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {beginStudioDeviceEnrollment} from '../lib/studio-device-enrollment.ts';
import {revokeSession} from '../lib/session-revocations.ts';
const previousSecret=process.env.SESSION_SECRET;
const secret='synthetic-studio-test-secret-0123456789';
function setup(){
 process.env.SESSION_SECRET=secret;const db=new Database(':memory:');
 const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'});
 const input={deviceId:randomUUID(),publicKey:key};const owner='a'.repeat(64),workspace='b'.repeat(64);
 db.exec('CREATE TABLE studio_device_authority(owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL)');db.prepare('INSERT INTO studio_device_authority VALUES(?,?)').run(owner,workspace);
 const token=()=>{const body=`${Date.now()+600000}.${randomBytes(18).toString('base64url')}`;return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;};
 return {db,input,owner,workspace,token,close(){db.close();if(previousSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previousSecret;}};
}
test('real signed browser session binds enrollment to server authority without storing the cookie',()=>{
 const f=setup();try{
  const token=f.token(),answer=beginStudioDeviceEnrollment(f.db,token,f.input);assert.ok(answer);assert.equal(answer.ownerHash,f.owner);assert.equal(answer.workspaceHash,f.workspace);assert.equal(answer.scope.join(','),'projects:read,recordings:upload');
  const row=f.db.prepare('SELECT * FROM studio_device_enrollment_challenges').get();assert.equal(row.device_id,f.input.deviceId);assert.notEqual(row.session_hash,token);assert.equal(row.owner_hash,f.owner);
  assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
 }finally{f.close();}
});
test('invalid, revoked, expired sessions and missing authority cannot issue challenge',()=>{
 for(const mode of ['invalid','revoked','expired','no-authority']){const f=setup();try{
  let token=f.token();if(mode==='invalid')token+='x';if(mode==='revoked')revokeSession(f.db,secret,token,Date.now());if(mode==='expired'){const body=`${Date.now()-1}.${randomBytes(18).toString('base64url')}`;token=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;}if(mode==='no-authority')f.db.exec('DROP TABLE studio_device_authority');
  assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='studio_device_enrollment_challenges'").get().n,0);
 }finally{f.close();}}
});
test('outer transactions are rejected before any enrollment schema is changed',()=>{
 const f=setup();try{const token=f.token();assert.throws(()=>f.db.transaction(()=>beginStudioDeviceEnrollment(f.db,token,f.input)).immediate(),/outer transaction forbidden/);assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='studio_device_enrollment_challenges'").get().n,0);}finally{f.close();}
});
test('session expiry during challenge insert rolls back mutation and remembers observed clock',()=>{
 const f=setup(),realNow=Date.now;let now=1_000_000;try{
  Date.now=()=>now;const body=`${now+1000}.${randomBytes(18).toString('base64url')}`,token=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
  // Initialize once using another valid challenge so the test trigger can simulate delay.
  const first=beginStudioDeviceEnrollment(f.db,token,{...f.input,deviceId:randomUUID()});assert.ok(first);
  f.db.function('synthetic_delay',()=>{now=1_001_001;return 0});f.db.exec('CREATE TRIGGER synthetic_delay_trigger AFTER INSERT ON studio_device_enrollment_challenges BEGIN SELECT synthetic_delay(); END');
  assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM studio_device_enrollment_challenges WHERE device_id=?').get(f.input.deviceId).n,0);
  assert.equal(f.db.prepare('SELECT floor_ms FROM studio_device_enrollment_clock WHERE id=1').get().floor_ms,1_001_001);
 }finally{Date.now=realNow;f.close();}
});

test('actual cookie logout and challenge creation serialize across separate processes',{timeout:15000},async()=>{
 const {fork}=await import('node:child_process');const {mkdtempSync,unlinkSync,rmdirSync}=await import('node:fs');const {join}=await import('node:path');
 const dir=mkdtempSync('/dev/shm/studio-real-enroll-'),file=join(dir,'fixture.sqlite');process.env.SESSION_SECRET=secret;
 const db=new Database(file);db.pragma('synchronous=FULL');db.exec('CREATE TABLE studio_device_authority(owner_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL)');db.prepare('INSERT INTO studio_device_authority VALUES(?,?)').run('a'.repeat(64),'b'.repeat(64));
 const body=`${Date.now()+600000}.${randomBytes(18).toString('base64url')}`,token=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`,device=randomUUID(),key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const workers=['begin','revoke'].map(mode=>{
  const process=fork(new URL('./fixtures/studio-enrollment-session-race-worker.mjs',import.meta.url),[file,mode,token,device,key],{stdio:['ignore','ignore','pipe','ipc'],env:{...globalThis.process.env,STUDIO_ENROLLMENT_TEST:'1'},execArgv:['--experimental-strip-types','--loader',new URL('./fixtures/ts-node-test-loader.mjs',import.meta.url).pathname]});
  return {process,ready:new Promise((resolve,reject)=>{process.once('message',resolve);process.once('error',reject);}),exit:new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal})))};
 });
 try{
  await Promise.all(workers.map(w=>w.ready));const replies=workers.map(w=>new Promise((resolve,reject)=>{w.process.once('message',resolve);w.process.once('error',reject);}));
  for(const w of workers)w.process.send('go');const [enrollment,revocation]=await Promise.all(replies);assert.equal(revocation.revoked,true);assert.ok(typeof enrollment.issued==='boolean',JSON.stringify(enrollment));
  assert.equal(beginStudioDeviceEnrollment(db,token,{deviceId:randomUUID(),publicKey:Buffer.from(key,'base64url')}),null);
 }finally{
  for(const w of workers)if(w.process.connected)w.process.disconnect();await Promise.all(workers.map(w=>w.exit));db.close();
  for(const name of ['fixture.sqlite','fixture.sqlite-journal','fixture.sqlite-wal','fixture.sqlite-shm'])try{unlinkSync(join(dir,name))}catch(error){if(error.code!=='ENOENT')throw error}rmdirSync(dir);
  if(previousSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previousSecret;
 }
});

test('observed expired signed browser cookie cannot revive after wall clock rollback',()=>{
 const f=setup(),realNow=Date.now;let now=1000;try{
  Date.now=()=>now;const body=`${2000}.${randomBytes(18).toString('base64url')}`,token=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
  now=2001;assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
  assert.equal(f.db.prepare('SELECT floor_ms FROM studio_device_enrollment_clock WHERE id=1').get().floor_ms,2001);
  now=1001;assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='studio_device_enrollment_challenges'").get().n,0);
 }finally{Date.now=realNow;f.close();}
});

test('browser cookie expiry after final auth check rolls back challenge',()=>{
 const f=setup(),realNow=Date.now;let now=1000,calls=0;try{
  const body=`2000.${randomBytes(18).toString('base64url')}`,token=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
  Date.now=()=>{calls++;if(calls===6)now=2001;return now};
  assert.equal(beginStudioDeviceEnrollment(f.db,token,f.input),null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM studio_device_enrollment_challenges').get().n,0);
  assert.equal(f.db.prepare('SELECT floor_ms FROM studio_device_enrollment_clock WHERE id=1').get().floor_ms,2001);
 }finally{Date.now=realNow;f.close();}
});
