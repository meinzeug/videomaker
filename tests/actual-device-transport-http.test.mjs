import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {createSyntheticOwnedProject,initializeOwnedDeviceAuth} from '../experiments/studio-device-http/owned-device-auth-core.mjs';
import {createOwnedDeviceHttpFixture} from '../experiments/studio-device-http/owned-router.mjs';
const classes=process.env.STUDIO_DEVICE_ACTUAL_JVM_CLASSES,stdlib=process.env.STUDIO_DEVICE_ACTUAL_STDLIB,gson=process.env.STUDIO_DEVICE_ACTUAL_GSON;
const enabled=typeof classes==='string'&&classes.startsWith('/dev/shm/studio-actual-transport.')&&typeof stdlib==='string'&&stdlib.startsWith('/home/dennis/.gradle/')&&typeof gson==='string'&&gson.startsWith('/home/dennis/.gradle/');
test('actual StudioClient transport completes scoped v2 login against loopback adapter',{skip:!enabled,timeout:30000},async()=>{
 const db=new Database(':memory:');initializeOwnedDeviceAuth(db);db.exec('CREATE TABLE fixture_owned_http_csrf(token_hash TEXT PRIMARY KEY,csrf_hash TEXT NOT NULL)');
 const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),hash=x=>createHash('sha256').update(x).digest('hex'),owner='a'.repeat(64),workspace='b'.repeat(64),project=randomUUID();
 db.prepare('INSERT INTO fixture_owned_auth_sessions VALUES(?,?,?,?,0)').run(hash(token),owner,workspace,Date.now()+600_000);db.prepare('INSERT INTO fixture_owned_http_csrf VALUES(?,?)').run(hash(token),hash(csrf));createSyntheticOwnedProject(db,project,owner,workspace);
 const server=createServer(createOwnedDeviceHttpFixture({db,challengeSecret:randomBytes(32)}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const child=spawn('java',['-Xmx64m','-XX:ActiveProcessorCount=1','-Dsun.net.http.allowRestrictedHeaders=true','-cp',`${classes}:${stdlib}:${gson}`,'de.kontrakurs.kontraprompter.cloud.ActualTransportHttpFixtureKt',`http://127.0.0.1:${server.address().port}`,token,csrf,project],{stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',chunk=>{out+=chunk.toString().slice(0,1000)});child.stderr.on('data',chunk=>{err+=chunk.toString().slice(0,2000)});
 try{const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});assert.deepEqual(status,{code:0,signal:null},err);assert.match(out,/^ACTUAL_DEVICE_TRANSPORT_FIXTURE_OK\s*$/);}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await new Promise(resolve=>server.close(resolve));db.close();}
});
