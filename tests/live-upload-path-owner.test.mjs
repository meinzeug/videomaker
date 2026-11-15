import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';
import {claimUploadPath,initializeUploadPathOwners} from '../lib/live-upload-path-owner.ts';

function fixture(){
 const directory=mkdtempSync(path.join(tmpdir(),'live-owner-test-'));
 const filename=path.join(directory,'synthetic.sqlite'),db=new Database(filename);
 db.pragma('synchronous=FULL');db.transaction(()=>initializeUploadPathOwners(db)).immediate();
 return {directory,filename,db,close(){db.close();unlinkSync(filename);rmdirSync(directory);}};
}
const tx=(db,r,p,u,mode)=>db.transaction(()=>claimUploadPath(db,r,p,u,mode)).immediate();
test('beide Reihenfolgen bleiben auf ursprünglichen Besitzer und Projekt gebunden',()=>{
 for(const first of ['live','full']){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),other=first==='live'?'full':'live';
  try{
   assert.deepEqual(tx(f.db,r,p,u,first),{created:true});assert.deepEqual(tx(f.db,r,p,u,first),{created:false});
   assert.throws(()=>tx(f.db,r,p,u,other),/OWNER_CONFLICT/);
   const q=randomUUID();assert.throws(()=>tx(f.db,r,q,cameraUploadIdFor(r,q),first),/OWNER_CONFLICT/);
   assert.throws(()=>tx(f.db,r,p,randomUUID(),first),/BINDING_MISMATCH/);
   assert.throws(()=>tx(f.db,null,p,u,first),/IDENTITY_REQUIRED/);
   assert.throws(()=>claimUploadPath(f.db,r,p,u,first),/TRANSACTION_REQUIRED/);
   assert.throws(()=>f.db.prepare('DELETE FROM live_upload_path_owners').run(),/cannot be deleted/);
  }finally{f.close();}
 }
});

test('bereits vorhandenes finales Video wird ohne Herkunftsnachweis nicht übernommen',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
 try{
  f.db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT,size INTEGER)');
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?,?)').run(u,p,123);
  assert.throws(()=>tx(f.db,r,p,u,'live'),/FINAL_RECORDING_EXISTS/);
  assert.throws(()=>tx(f.db,r,p,u,'full'),/FINAL_RECORDING_EXISTS/);
  assert.deepEqual(f.db.prepare('SELECT id,project_id,size FROM project_recordings').get(),{id:u,project_id:p,size:123});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
 }finally{f.close();}
});

function start(f,r,p,u,mode,point='normal'){
 const worker=fork(new URL('./fixtures/live-path-owner-worker.mjs',import.meta.url),[f.filename,r,p,u,mode,point],{stdio:['ignore','ignore','pipe','ipc'],execArgv:['--experimental-strip-types']});
 const ready=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(Error(`worker exited ${code}`)));});
 return {worker,ready};
}
test('zwei Prozesse können nicht beide Pfade für denselben Take belegen',async()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),workers=['live','full'].map(x=>start(f,r,p,u,x));
 const exited=workers.map(({worker})=>new Promise(resolve=>worker.once('exit',resolve)));
 try{
  await Promise.all(workers.map(x=>x.ready));
  const replies=workers.map(({worker})=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
  for(const {worker} of workers)worker.send('go');
  const results=await Promise.all(replies);
  assert.equal(results.filter(x=>x.result?.created===true).length,1);assert.equal(results.filter(x=>x.error==='OWNER_CONFLICT').length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,1);
 }finally{for(const {worker} of workers)if(worker.connected)worker.disconnect();await Promise.all(exited);f.close();}
});

test('Prozessabbruch vor und nach Commit behält keine halbe bzw eine dauerhafte Zuordnung',async()=>{
 for(const point of ['before-commit','after-commit']){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),{worker,ready}=start(f,r,p,u,'live',point);
  try{
   await ready;const exited=new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal})));worker.send('go');
   assert.equal((await exited).signal,'SIGKILL');
   const row=f.db.prepare('SELECT path FROM live_upload_path_owners WHERE recording_id=?').get(r);
   if(point==='before-commit'){assert.equal(row,undefined);assert.deepEqual(tx(f.db,r,p,u,'full'),{created:true});}
   else{assert.equal(row.path,'live');assert.deepEqual(tx(f.db,r,p,u,'live'),{created:false});assert.throws(()=>tx(f.db,r,p,u,'full'),/OWNER_CONFLICT/);}
  }finally{if(worker.connected)worker.disconnect();f.close();}
 }
});
