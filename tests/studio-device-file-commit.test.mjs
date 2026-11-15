import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmdirSync,unlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createStudioDeviceAuth,initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';
import {commitSyntheticFile} from '../experiments/studio-device-http/fixture-file-commit.mjs';

function setup(){
 const root=mkdtempSync('/dev/shm/studio-file-commit.'),file=join(root,'synthetic.sqlite');writeFileSync(join(root,'.fixture'),'synthetic-device-file-commit\n');
 const db=new Database(file);db.pragma('synchronous=FULL');initializeStudioDeviceAuth(db);
 db.exec('CREATE TABLE fixture_projects(id TEXT PRIMARY KEY); CREATE TABLE fixture_file_publications(recording_id TEXT PRIMARY KEY,project_id TEXT,size INTEGER,sha256 TEXT); CREATE TABLE fixture_file_tombstones(recording_id TEXT PRIMARY KEY)');
 let now=Date.now();const secret=randomBytes(32),auth=createStudioDeviceAuth(db,()=>now,secret),device=randomUUID(),project=randomUUID(),recording=randomUUID();
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=keys.publicKey.export({format:'der',type:'spki'}),owner='a'.repeat(64);
 const e=auth.beginEnrollment(device,publicKey,['recordings:upload'],owner,()=>true);
 assert.ok(auth.completeEnrollment(device,e.challengeId,sign('sha256',e.message,keys.privateKey),owner,()=>true));
 const c=auth.beginLogin(device),ticket=auth.completeLogin(device,c.challengeToken,sign('sha256',c.message,keys.privateKey)).ticket;
 db.prepare('INSERT INTO fixture_projects VALUES(?)').run(project);
 return {root,file,db,secret,auth,device,project,recording,ticket,bytes:Buffer.from('synthetic recording'),get now(){return now;},
  close(){db.close();for(const name of readdirSync(root)){
   if(!/^((\.fixture)|(synthetic\.sqlite(-journal|-wal|-shm)?)|(stage-[0-9a-f-]{36})|([0-9a-f-]{36}\.fixture))$/.test(name))throw Error(`unknown fixture file ${name}`);
   unlinkSync(join(root,name));}rmdirSync(root);}};
}
function args(f,extra={}){return {root:f.root,ticket:f.ticket,project:f.project,recording:f.recording,bytes:f.bytes,clock:Date.now,...extra};}
test('verified synthetic file is retryable; altered or deleted bytes are never silently restored',()=>{
 const f=setup(),path=join(f.root,`${f.recording}.fixture`);try{
  assert.equal(commitSyntheticFile(f.db,args(f)),'created');assert.deepEqual(readFileSync(path),f.bytes);
  assert.equal(commitSyntheticFile(f.db,args(f)),'replayed');
  writeFileSync(path,'different');assert.equal(commitSyntheticFile(f.db,args(f)),'uncertain');assert.equal(readFileSync(path,'utf8'),'different');
  unlinkSync(path);assert.equal(commitSyntheticFile(f.db,args(f)),'uncertain');assert.equal(existsSync(path),false);
 }finally{f.close();}
});
test('expiry during linked-file commit removes only the own link and retains no publication',()=>{
 const f=setup(),expires=f.now+300_000;let calls=0;
 try{
  assert.equal(commitSyntheticFile(f.db,args(f,{clock:()=>++calls===1?expires-1:expires+1})),'denied');
  assert.equal(existsSync(join(f.root,`${f.recording}.fixture`)),false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,0);
  assert.equal(f.db.prepare('SELECT floor_ms FROM studio_auth_clock').get().floor_ms,expires+1);
 }finally{f.close();}
});
test('a tombstoned synthetic recording cannot be published',()=>{
 const f=setup();try{f.db.prepare('INSERT INTO fixture_file_tombstones VALUES(?)').run(f.recording);assert.equal(commitSyntheticFile(f.db,args(f)),'deleted');assert.equal(existsSync(join(f.root,`${f.recording}.fixture`)),false);}finally{f.close();}
});
function start(f,mode){
 const worker=fork(new URL('./fixtures/studio-device-file-race-worker.mjs',import.meta.url),[f.root,mode,f.ticket,f.project,f.recording,f.device,f.secret.toString('hex')],{stdio:['ignore','ignore','pipe','ipc']});
 const ready=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
 const exited=new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal})));
 return {worker,ready,exited};
}
test('crash after link before DB commit leaves preserved orphan and retry fails closed',{timeout:15000},async()=>{
 const f=setup(),w=start(f,'crash'),target=join(f.root,`${f.recording}.fixture`);
 try{
  await w.ready;w.worker.send('go');assert.equal((await w.exited).signal,'SIGKILL');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,0);
  assert.deepEqual(readFileSync(target),f.bytes);assert.equal(commitSyntheticFile(f.db,args(f)),'uncertain');assert.deepEqual(readFileSync(target),f.bytes);
 }finally{if(w.worker.connected)w.worker.disconnect();f.close();}
});
test('crash after DB commit leaves verified file and retry returns existing receipt',{timeout:15000},async()=>{
 const f=setup(),w=start(f,'after-commit'),target=join(f.root,`${f.recording}.fixture`);
 try{
  await w.ready;w.worker.send('go');assert.equal((await w.exited).signal,'SIGKILL');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,1);
  assert.deepEqual(readFileSync(target),f.bytes);assert.equal(commitSyntheticFile(f.db,args(f)),'replayed');assert.deepEqual(readFileSync(target),f.bytes);
 }finally{if(w.worker.connected)w.worker.disconnect();f.close();}
});
test('file publication and device revoke serialize across processes',{timeout:15000},async()=>{
 const f=setup(),workers=['commit','revoke'].map(mode=>start(f,mode));
 try{
  await Promise.all(workers.map(w=>w.ready));
  const replies=workers.map(w=>new Promise((resolve,reject)=>{w.worker.once('message',resolve);w.worker.once('error',reject);}));
  for(const w of workers)w.worker.send('go');const [publish,revoke]=await Promise.all(replies);
  assert.equal(revoke.result,true);assert.ok(['created','denied'].includes(publish.result),JSON.stringify(publish));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,publish.result==='created'?1:0);
  if(publish.result==='created')assert.deepEqual(readFileSync(join(f.root,`${f.recording}.fixture`)),f.bytes);
  assert.equal(commitSyntheticFile(f.db,args(f)),'denied');
 }finally{
  for(const w of workers)if(w.worker.connected)w.worker.disconnect();
  const exits=await Promise.all(workers.map(w=>w.exited));assert.ok(exits.every(x=>x.code===0),JSON.stringify(exits));f.close();
 }
});
