import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import Database from 'better-sqlite3';
import {createStudioDeviceAuth,initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';

const classes=process.env.STUDIO_DEVICE_JVM_CLASS_DIR,stdlib=process.env.STUDIO_DEVICE_KOTLIN_STDLIB;
const enabled=typeof classes==='string'&&classes.startsWith('/dev/shm/studio-device-cross.')&&typeof stdlib==='string'&&stdlib.startsWith('/home/dennis/.gradle/');
test('ephemeral JVM P-256 proves exact enrollment/login and Node revocation',{skip:!enabled,timeout:30000},async()=>{
 const device=randomUUID(),owner='a'.repeat(64),db=new Database(':memory:');initializeStudioDeviceAuth(db);
 let now=1_000_000;const auth=createStudioDeviceAuth(db,()=>now,randomBytes(32));
 const child=spawn('java',['-Xmx64m','-XX:ActiveProcessorCount=1','-cp',`${classes}:${stdlib}`,'de.kontrakurs.kontraprompter.cloud.StudioDeviceSignatureFixtureKt',device],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,1000);});
 const next=async(prefix)=>{const row=await lines.next();assert.equal(row.done,false,stderr);const [kind,value]=row.value.split('\t');assert.equal(kind,prefix);return value;};
 const sign=async(fields)=>{child.stdin.write(fields.join('\t')+'\n');return Buffer.from(await next('SIG'),'base64');};
 try{
  const publicKey=Buffer.from(await next('PUB'),'base64'),scope=['projects:read','recordings:upload'];
  const enrollment=auth.beginEnrollment(device,publicKey,scope,owner,()=>true);assert.ok(enrollment);
  const parts=enrollment.message.toString('utf8').split('\n');
  assert.equal(parts[0],'videomaker-studio-device-auth/enroll/v1');assert.equal(parts[1],device);assert.equal(parts[2],enrollment.challengeId);assert.equal(parts[6],owner);
  const proof=await sign(['ENROLL',enrollment.challengeId,parts[3],owner]);
  assert.deepEqual(auth.completeEnrollment(device,enrollment.challengeId,proof,owner,()=>true),{enrolled:true});
  assert.equal(auth.completeEnrollment(device,enrollment.challengeId,proof,owner,()=>true),null);
  const login=auth.beginLogin(device);assert.ok(login);
  const sig=await sign(['LOGIN',login.challengeId,login.challengeToken]);
  const altered=Buffer.from(sig);altered[altered.length-1]^=1;
  assert.equal(auth.completeLogin(device,login.challengeToken,altered),null);
  const result=auth.completeLogin(device,login.challengeToken,sig);assert.ok(result);
  assert.equal(auth.completeLogin(device,login.challengeToken,sig),null);
  assert.equal(auth.permits(result.ticket,'projects:read'),true);
  assert.equal(auth.permits(result.ticket,'recordings:upload'),true);
  assert.equal(auth.permits(result.ticket,'admin'),false);
  const expired=auth.beginLogin(device),expiredSig=await sign(['LOGIN',expired.challengeId,expired.challengeToken]);
  now+=60_001;assert.equal(auth.completeLogin(device,expired.challengeToken,expiredSig),null);
  const pending=auth.beginLogin(device),pendingSig=await sign(['LOGIN',pending.challengeId,pending.challengeToken]);
  assert.equal(auth.revoke(device,()=>true),true);
  assert.equal(auth.completeLogin(device,pending.challengeToken,pendingSig),null);
  assert.equal(auth.permits(result.ticket,'projects:read'),false);
  assert.equal(auth.beginLogin(device),null);
 }finally{
  child.stdin.end('STOP\n');
  await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});
  db.close();
 }
});
