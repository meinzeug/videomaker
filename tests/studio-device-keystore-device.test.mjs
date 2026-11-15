import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import Database from 'better-sqlite3';
import {createStudioDeviceAuth,initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';

// This test is skipped unless an operator explicitly provides both values.
// The APK/app process is not touched; this is a shell-UID test key only.
const serial=process.env.STUDIO_DEVICE_TEST_ADB_SERIAL,remote=process.env.STUDIO_DEVICE_TEST_ADB_ARCHIVE;
const enabled=['R5CR60Q07YN','HEHU4TQSINOJEQG6'].includes(serial)&&typeof remote==='string'&&/^\/data\/local\/tmp\/videomaker-studio-fixture-[0-9a-f-]{36}\.zip$/.test(remote);
test('Android shell Keystore signs device enrollment and revocation survives',{skip:!enabled,timeout:60000},async()=>{
 const device=randomUUID(),owner='a'.repeat(64),db=new Database(':memory:');initializeStudioDeviceAuth(db);
 let now=1_000_000;const auth=createStudioDeviceAuth(db,()=>now,randomBytes(32));
 const className='de.kontrakurs.kontraprompter.cloud.StudioDeviceKeystoreFixtureKt';
 const child=spawn('adb',['-s',serial,'shell','-T',`CLASSPATH=${remote}`,'app_process','/system/bin',className,device],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 let diagnostic='';child.stderr.on('data',chunk=>{diagnostic+=chunk.toString();});
 const next=async(prefix)=>{const row=await lines.next();assert.equal(row.done,false,diagnostic.slice(-2000));const [kind,value]=row.value.split('\t');assert.equal(kind,prefix);return value;};
 const sign=async(fields)=>{child.stdin.write(fields.join('\t')+'\n');return Buffer.from(await next('SIG'),'base64');};
 try{
  const publicKey=Buffer.from(await next('PUB'),'base64'),scope=['projects:read','recordings:upload'];
  const enrollment=auth.beginEnrollment(device,publicKey,scope,owner,()=>true);assert.ok(enrollment);
  const parts=enrollment.message.toString('utf8').split('\n');
  assert.equal(parts[1],device);assert.equal(parts[2],enrollment.challengeId);assert.equal(parts[6],owner);
  const proof=await sign(['ENROLL',enrollment.challengeId,parts[3],owner]);
  assert.deepEqual(auth.completeEnrollment(device,enrollment.challengeId,proof,owner,()=>true),{enrolled:true});
  const login=auth.beginLogin(device),sig=await sign(['LOGIN',login.challengeId,login.challengeToken]);
  const ticket=auth.completeLogin(device,login.challengeToken,sig);assert.ok(ticket);
  assert.equal(auth.completeLogin(device,login.challengeToken,sig),null);
  assert.equal(auth.permits(ticket.ticket,'projects:read'),true);
  assert.equal(auth.permits(ticket.ticket,'admin'),false);
  const pending=auth.beginLogin(device),pendingSig=await sign(['LOGIN',pending.challengeId,pending.challengeToken]);
  assert.equal(auth.revoke(device,()=>true),true);
  assert.equal(auth.completeLogin(device,pending.challengeToken,pendingSig),null);
  assert.equal(auth.permits(ticket.ticket,'projects:read'),false);
  child.stdin.end('STOP\n');
  const cleaned=await next('FIXTURE_CLEANUP_OK');assert.equal(cleaned,undefined);
  const exit=child.exitCode!==null||child.signalCode!==null?{code:child.exitCode,signal:child.signalCode}:
   await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  assert.deepEqual(exit,{code:0,signal:null});
  const match=diagnostic.match(/FIXTURE_ALIAS\s+(videomaker-studio-test-[0-9a-f-]{36})/);
  assert.ok(match,'test alias missing');const alias=match[1];
  const check=spawnSync('adb',['-s',serial,'shell','-T',`CLASSPATH=${remote}`,'app_process','/system/bin',className,'CHECK',alias],{encoding:'utf8',timeout:15000});
  assert.equal(check.status,0,check.stderr);assert.match(check.stdout,/FIXTURE_ALIAS_PRESENT=false/);
  console.log('Verified absent own test alias:',alias);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){
   child.stdin.end('STOP\n');
   await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
   if(child.exitCode===null&&child.signalCode===null)child.kill();
  }
  const alias=diagnostic.match(/FIXTURE_ALIAS\s+(videomaker-studio-test-[0-9a-f-]{36})/)?.[1];
  if(alias){
   const check=spawnSync('adb',['-s',serial,'shell','-T',`CLASSPATH=${remote}`,'app_process','/system/bin',className,'CHECK',alias],{encoding:'utf8',timeout:15000});
   assert.equal(check.status,0,`Testalias ${alias}: ${check.stderr}`);
   assert.match(check.stdout,/FIXTURE_ALIAS_PRESENT=false/,`Testalias ${alias} nicht entfernt`);
  }
  db.close();
 }
});
