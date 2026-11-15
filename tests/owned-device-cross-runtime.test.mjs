import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import Database from 'better-sqlite3';
import {createOwnedDeviceAuth,createSyntheticOwnedProject,initializeOwnedDeviceAuth} from '../experiments/studio-device-http/owned-device-auth-core.mjs';

const classes=process.env.STUDIO_DEVICE_JVM_CLASS_DIR,stdlib=process.env.STUDIO_DEVICE_KOTLIN_STDLIB;
const enabled=typeof classes==='string'&&classes.startsWith('/dev/shm/studio-owned-device-cross.')&&typeof stdlib==='string'&&stdlib.startsWith('/home/dennis/.gradle/');
test('v2 Kotlin signatures bind actual Node enrollment, owner, workspace and session',{skip:!enabled,timeout:30000},async()=>{
 const device=randomUUID(),owner='a'.repeat(64),workspace='b'.repeat(64),foreign='c'.repeat(64),project=randomUUID(),db=new Database(':memory:');initializeOwnedDeviceAuth(db);
 const session=randomBytes(32).toString('base64url'),sessionHash=createHash('sha256').update(session).digest('hex');
 db.prepare('INSERT INTO fixture_owned_auth_sessions VALUES(?,?,?,?,0)').run(sessionHash,owner,workspace,1_600_000);
 createSyntheticOwnedProject(db,project,owner,workspace);let now=1_000_000;const auth=createOwnedDeviceAuth(db,()=>now,randomBytes(32));
 const child=spawn('java',['-Xmx64m','-XX:ActiveProcessorCount=1','-cp',`${classes}:${stdlib}`,'de.kontrakurs.kontraprompter.cloud.OwnedDeviceSignatureFixtureKt',device],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,1000);});
 const next=async(prefix)=>{const row=await lines.next();assert.equal(row.done,false,stderr);const [kind,value]=row.value.split('\t');assert.equal(kind,prefix);return value;};
 const sign=async(fields)=>{child.stdin.write(fields.join('\t')+'\n');return Buffer.from(await next('SIG'),'base64');};
 try{
  const key=Buffer.from(await next('PUB'),'base64'),scope=['projects:read','recordings:upload'];
  const enrollment=auth.beginEnrollment(device,key,scope,session);assert.ok(enrollment);const parts=enrollment.message.toString('utf8').split('\n');
  assert.equal(parts[0],'videomaker-studio-device-auth/enroll/v2');assert.equal(parts[6],owner);assert.equal(parts[7],workspace);assert.equal(parts[8],sessionHash);
  const wrong=await sign(['ENROLL',enrollment.challengeId,parts[3],owner,foreign,sessionHash]);assert.equal(auth.completeEnrollment(device,enrollment.challengeId,wrong,session),null);
  const sig=await sign(['ENROLL',enrollment.challengeId,parts[3],owner,workspace,sessionHash]);assert.deepEqual(auth.completeEnrollment(device,enrollment.challengeId,sig,session),{enrolled:true});assert.equal(auth.completeEnrollment(device,enrollment.challengeId,sig,session),null);
  const login=auth.beginLogin(device),wrongLogin=await sign(['LOGIN',login.challengeId,login.challengeToken,foreign,workspace]);assert.equal(auth.completeLogin(device,login.challengeToken,wrongLogin),null);
  const proof=await sign(['LOGIN',login.challengeId,login.challengeToken,owner,workspace]),ticket=auth.completeLogin(device,login.challengeToken,proof);assert.ok(ticket);assert.equal(auth.completeLogin(device,login.challengeToken,proof),null);
  assert.equal(auth.permits(ticket.ticket,'projects:read',project),false);assert.equal(auth.grantProject(device,project,session),true);assert.equal(auth.permits(ticket.ticket,'projects:read',project),true);
  assert.equal(auth.revoke(device,session),true);assert.equal(auth.permits(ticket.ticket,'projects:read',project),false);assert.equal(auth.beginLogin(device),null);
 }finally{child.stdin.end('STOP\n');await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});db.close();}
});
