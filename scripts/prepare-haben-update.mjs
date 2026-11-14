#!/usr/bin/env node
// Detached worker. It checks out untrusted source, but never executes it.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {lstat, readdir, rename, rm, statfs, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const upstream='https://github.com/firsttris/haben.git';
// prlimit constrains every individual file. The watcher limits aggregate checkout
// size and keeps a reserve for the other applications sharing the filesystem.
const maxFile=128*1024*1024, maxTree=256*1024*1024, minFree=1024*1024*1024;
async function freeBytes(dir){const fs=await statfs(dir,{bigint:true});return fs.bavail*fs.bsize;}
async function treeSize(dir,limit=maxTree){
 let size=0,nodes=0;const pending=[dir];
 while(pending.length){
  const current=pending.pop();let entries;
  try{entries=await readdir(current,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const entry of entries){
   if(++nodes>100000)throw new Error('too many files');
   const target=path.join(current,entry.name);
   let info;try{info=await lstat(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(info.isDirectory())pending.push(target);else if(info.isFile())size+=info.size;
   if(size>limit)throw new Error('candidate too large');
  }
 }
 return size;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function groupExists(pid){try{process.kill(-pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
function killGroup(pid){try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
export async function git(args,cwd,candidate,limits={}){
 const {reserve=minFree,tree=maxTree,timeout=180000,interval=500}=limits;
 if(await freeBytes(cwd)<BigInt(reserve+tree))throw new Error('insufficient free space');
 if(candidate)await treeSize(candidate,tree);
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/prlimit',[`--fsize=${maxFile}:${maxFile}`,'--','/usr/bin/git',...args],{cwd,stdio:['ignore','pipe','ignore'],env:process.env,detached:true});
  let out='',failure='',monitoring=false,finished=false;
  const stop=reason=>{if(failure||finished)return;failure=reason;if(child.pid){try{killGroup(child.pid);}catch{failure='process group could not be stopped';}}};
  child.stdout.on('data',chunk=>{out+=chunk;if(out.length>1024)stop('git output too large');});
  const timer=setTimeout(()=>stop('git timed out'),timeout);
  const watcher=setInterval(async()=>{
   if(monitoring||finished)return;monitoring=true;
   try{if(await freeBytes(cwd)<BigInt(reserve))throw new Error('space reserve exhausted');if(candidate)await treeSize(candidate,tree);}
   catch{stop('resource limit exceeded');}finally{monitoring=false;}
  },interval);
  child.on('error',error=>{failure=error.message;});
  child.on('close',async code=>{
   finished=true;clearTimeout(timer);clearInterval(watcher);
   // A Git child may survive its parent. Do not release the exclusive lock
   // until the process group is demonstrably gone.
   try{
    if(child.pid&&groupExists(child.pid)){
     killGroup(child.pid);
     for(let i=0;i<40&&groupExists(child.pid);i++)await pause(100);
     if(groupExists(child.pid)){const error=new Error('Ungeklärter Git-Prozess; Sperre bleibt bestehen.');error.unsafeToUnlock=true;return reject(error);}
    }
   }catch(error){error.unsafeToUnlock=true;return reject(error);}
   if(code!==0||failure)return reject(new Error(failure||'git failed'));
   try{if(await freeBytes(cwd)<BigInt(reserve))throw new Error('space reserve exhausted');if(candidate)await treeSize(candidate,tree);resolve(out.trim());}
   catch(error){reject(error);}
  });
 });
}

async function status(dir,state,message,commit){
 const temp=path.join(dir,`.status-${randomBytes(12).toString('hex')}`);
 await writeFile(temp,JSON.stringify({state,message,updatedAt:new Date().toISOString(),...(commit?{commit}:{})}),{mode:0o600,flag:'wx'});
 await rename(temp,path.join(dir,'status.json'));
}
export async function prepare(dir,id,patchDir,runGit=git){
 if(!path.isAbsolute(dir)||!path.isAbsolute(patchDir)||!/^[a-f0-9]{24}$/.test(id))throw new Error('Ungültige interne Parameter.');
 const candidate=path.join(dir,`candidate-${id}`); let commit,stage='fetching',unsafeToUnlock=false;
 try{
  await status(dir,'fetching','Aktueller Haben-Quelltext wird geladen.');
  await runGit(['clone','--depth=1','--branch','main','--no-tags','--',upstream,candidate],dir,candidate);
  commit=await runGit(['rev-parse','HEAD'],candidate,candidate);
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('Ungültige Commit-ID.');
  stage='patching';
  await status(dir,'patching','Anpassungen werden auf den Kandidaten angewendet.',commit);
  const names=(await readdir(patchDir)).filter(name=>/^\d{4}-[a-z0-9-]+\.patch$/.test(name)).sort();
  if(names.length===0)throw new Error('Keine Integrationspatches vorhanden.');
  for(const name of names){const patch=path.join(patchDir,name),info=await lstat(patch);if(!info.isFile()||info.isSymbolicLink())throw new Error('Patch ist keine reguläre Datei.');
   await runGit(['apply','--check','--',patch],candidate,candidate);await runGit(['apply','--',patch],candidate,candidate);
  }
  await status(dir,'prepared','Kandidat vorbereitet. Er ist weder getestet noch installiert; die Datenbank wurde nicht verändert.',commit);
 }catch(error){
  unsafeToUnlock=error.unsafeToUnlock===true;
  await status(dir,unsafeToUnlock?'unknown':'failed',unsafeToUnlock?'Ein Git-Prozess ließ sich nicht sicher beenden. Die Sperre bleibt bestehen; bitte den Server prüfen.':stage==='fetching'?'Quelltext konnte nicht geladen werden. Netzwerk und Speicherplatz auf dem Server prüfen.':'Die Videomaker-Anpassungen passen nicht auf diesen Quellstand oder konnten nicht gelesen werden. Kandidat und Patches auf dem Server prüfen.',commit).catch(()=>{});
 }finally{if(!unsafeToUnlock)await rm(path.join(dir,'running'),{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const [, ,dir,id,patchDir]=process.argv;
 await prepare(dir,id,patchDir);
}
