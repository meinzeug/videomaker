import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepare} from '../scripts/prepare-haben-update.mjs';
import {startUpdate, updateStatus, UpdateBusy} from '../lib/haben-update.ts';

const withFixture=async fn=>{const dir=await mkdtemp(path.join(os.tmpdir(),'haben-candidate-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const id='a'.repeat(24),commit='b'.repeat(40);
async function setup(dir){const patches=path.join(dir,'patches');await mkdir(patches);await writeFile(path.join(patches,'0001-test.patch'),'patch');await mkdir(path.join(dir,'running'));return patches;}
test('worker clones only fixed upstream and applies only regular patch files without executing candidate code',async()=>withFixture(async dir=>{
 const patches=await setup(dir),calls=[];
 const fake=async(args,cwd)=>{calls.push([args,cwd]);if(args[0]==='clone')return '';if(args[0]==='rev-parse')return commit;return '';};
 await prepare(dir,id,patches,fake);
 const status=JSON.parse(await readFile(path.join(dir,'status.json'),'utf8'));
 assert.equal(status.state,'prepared');assert.equal(status.commit,commit);assert.match(status.message,/weder getestet noch installiert/);
 assert.deepEqual(calls.map(([args])=>args[0]),['clone','rev-parse','apply','apply']);
 assert.deepEqual(calls[0][0].slice(1,7),['--depth=1','--branch','main','--no-tags','--','https://github.com/firsttris/haben.git']);
 assert.deepEqual(calls[2][0].slice(0,3),['apply','--check','--']);assert.equal((await readdir(dir)).includes('running'),false);
}));
test('patch conflicts fail honestly, do not disclose git errors and release lock',async()=>withFixture(async dir=>{
 const patches=await setup(dir);const fake=async args=>{if(args[0]==='rev-parse')return commit;if(args[0]==='apply')throw Error('secret test output');return '';};
 await prepare(dir,id,patches,fake);const raw=await readFile(path.join(dir,'status.json'),'utf8');const status=JSON.parse(raw);
 assert.equal(status.state,'failed');assert.match(status.message,/Anpassungen/);assert.doesNotMatch(raw,/secret test output/);assert.equal((await readdir(dir)).includes('running'),false);
}));
test('symlinked patches and malformed commit never produce a prepared candidate',async()=>{
 for(const variant of ['symlink','commit'])await withFixture(async dir=>{const patches=await setup(dir);if(variant==='symlink'){await rm(path.join(patches,'0001-test.patch'));await symlink('/etc/passwd',path.join(patches,'0001-test.patch'));}
 const calls=[];await prepare(dir,id,patches,async args=>{calls.push(args[0]);return args[0]==='rev-parse'?(variant==='commit'?'bad':commit):'';});
 const status=JSON.parse(await readFile(path.join(dir,'status.json'),'utf8'));assert.equal(status.state,'failed');assert.equal(calls.includes('apply'),false);
 });
});
test('a running or interrupted job is not overwritten',async()=>withFixture(async dir=>{
 const before=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 try{await mkdir(path.join(dir,'haben-updates'),{mode:0o700});await mkdir(path.join(dir,'haben-updates','running'));assert.equal((await updateStatus()).state,'unknown');
 const results=await Promise.allSettled([startUpdate(),startUpdate()]);assert.ok(results.every(x=>x.status==='rejected'&&x.reason instanceof UpdateBusy));assert.equal((await readdir(path.join(dir,'haben-updates'))).includes('running'),true);
 }finally{if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;}
}));
test('unsafe directories are rejected before a worker starts',async()=>withFixture(async dir=>{
 const before=process.env.DATA_DIR,alias=path.join(dir,'alias');await mkdir(path.join(dir,'real'));await symlink(path.join(dir,'real'),alias);process.env.DATA_DIR=alias;
 try{await assert.rejects(startUpdate(),/nicht sicher/);assert.deepEqual(await readdir(path.join(dir,'real')),[]);}finally{if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;}
}));
test('a session revoked before launch does not leave a lock or start a worker',async()=>withFixture(async dir=>{
 const before=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 try{await assert.rejects(startUpdate(async()=>false),/Sitzung/);const workspace=path.join(dir,'haben-updates');assert.equal((await readdir(workspace)).includes('running'),false);assert.equal((await updateStatus()).state,'failed');}
 finally{if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;}
}));
test('uncertain process termination retains the lock and exposes the safety status',async()=>withFixture(async dir=>{
 const before=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 try{
  const workspace=path.join(dir,'haben-updates');await mkdir(workspace,{mode:0o700});const patches=await setup(workspace);
  await prepare(workspace,id,patches,async()=>{const error=Error('secret internal failure');error.unsafeToUnlock=true;throw error;});
  assert.equal((await updateStatus()).state,'unknown');assert.equal((await readdir(workspace)).includes('running'),true);
  await assert.rejects(startUpdate(),UpdateBusy);
 }finally{if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;}
}));

test('real git timeout kills its child process group',async()=>withFixture(async dir=>{
 const {git}=await import('../scripts/prepare-haben-update.mjs');const script=path.join(dir,'group-test.sh'),pidfile=path.join(dir,'child.pid');
 await writeFile(script,`#!/bin/sh\nsleep 60 &\necho $! > '${pidfile}'\nwait\n`,{mode:0o700});
 await assert.rejects(git(['-c',`alias.test=!/bin/sh ${script}`,'test'],dir,null,{timeout:500,reserve:0,tree:1,interval:100}));
 const pid=Number(await readFile(pidfile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
 try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');assert.equal(stat.split(') ')[1][0],'Z','child must be dead or a zombie, not running');}catch(error){if(error.code!=='ENOENT')throw error;}
}));

test('real disk guards reject insufficient reserve and overlarge candidates before running git',async()=>withFixture(async dir=>{
 const {git}=await import('../scripts/prepare-haben-update.mjs');
 await assert.rejects(git(['--version'],dir,null,{reserve:Number.MAX_SAFE_INTEGER,tree:0}),/insufficient free space/);
 await writeFile(path.join(dir,'large-file'),'0123456789');
 await assert.rejects(git(['--version'],dir,dir,{reserve:0,tree:5}),/candidate too large/);
}));

test('dashboard preparation remains disabled independently of environment variables',async()=>{
 const {updateEnabled,updateDisabledMessage}=await import('../lib/haben-update.ts');
 assert.equal(updateEnabled(),false);assert.match(updateDisabledMessage,/Speicherbegrenzung/);
 process.env.HABEN_UPDATE_ENABLED='true';try{assert.equal(updateEnabled(),false);}finally{delete process.env.HABEN_UPDATE_ENABLED;}
});
