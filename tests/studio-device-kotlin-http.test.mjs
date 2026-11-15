import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';
import {createDeviceHttpFixture} from '../experiments/studio-device-http/router.mjs';

const classes=process.env.STUDIO_DEVICE_HTTP_JVM_CLASSES,stdlib=process.env.STUDIO_DEVICE_HTTP_STDLIB,gson=process.env.STUDIO_DEVICE_HTTP_GSON;
const enabled=typeof classes==='string'&&classes.startsWith('/dev/shm/studio-device-http-client.')&&
 typeof stdlib==='string'&&stdlib.startsWith('/home/dennis/.gradle/')&&typeof gson==='string'&&gson.startsWith('/home/dennis/.gradle/');
test('real Kotlin loopback HTTP enrolls, discards late login and observes revoke',{skip:!enabled,timeout:30000},async()=>{
 const db=new Database(':memory:');initializeStudioDeviceAuth(db);db.exec('CREATE TABLE fixture_browser_sessions(token_hash TEXT PRIMARY KEY,csrf_hash TEXT NOT NULL)');
 const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
 const hash=x=>createHash('sha256').update(x).digest('hex');
 db.prepare('INSERT INTO fixture_browser_sessions VALUES(?,?)').run(hash(token),hash(csrf));
 const server=createServer(createDeviceHttpFixture({db,challengeSecret:randomBytes(32),ownerSecret:randomBytes(32)}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let child;
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  child=spawn('java',['-Xmx96m','-XX:ActiveProcessorCount=1','-Dsun.net.http.allowRestrictedHeaders=true','-cp',`${classes}:${stdlib}:${gson}`,'de.kontrakurs.kontraprompter.cloud.DeviceHttpFixtureKt',base,token,csrf],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x.toString();});child.stderr.on('data',x=>{stderr+=x.toString();});
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  assert.deepEqual(result,{code:0,signal:null},stderr.slice(-2000));assert.match(stdout,/^DEVICE_HTTP_FIXTURE_OK\s*$/);
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
  await new Promise(resolve=>server.close(resolve));db.close();
 }
});
