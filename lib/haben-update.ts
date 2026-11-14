import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

export type UpdateStatus={state:'disabled'|'idle'|'starting'|'fetching'|'patching'|'prepared'|'failed'|'unknown'; message:string; commit?:string; updatedAt?:string};
// Fail closed until the worker is placed on a separate filesystem with a
// *verified hard quota*. Polling free space and candidate size is not a quota.
export const updateDisabledMessage='Die Update-Vorbereitung ist noch nicht freigeschaltet. Zuerst muss ein getrennter Arbeitsbereich mit überprüfter fester Speicherbegrenzung eingerichtet werden.';
export function updateEnabled():boolean{return false;}
const idle:UpdateStatus={state:'idle',message:'Noch kein Update vorbereitet.'};
const allowedStates=new Set(['starting','fetching','patching','prepared','failed','unknown']);

async function workspace(){
 const data=path.resolve(process.env.DATA_DIR||'./data');
 const info=await lstat(data);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o022)!==0||(info.uid!==process.getuid?.()&&info.uid!==0))throw new Error('Das Datenverzeichnis ist nicht sicher eingerichtet.');
 const canonical=await realpath(data), dir=path.join(canonical,'haben-updates');
 try{await mkdir(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const d=await lstat(dir);
 if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o077)!==0||d.uid!==process.getuid?.())throw new Error('Das Update-Verzeichnis ist nicht sicher eingerichtet.');
 return dir;
}
async function writeStatus(dir:string,state:UpdateStatus){
 const temp=path.join(dir,`.status-${randomBytes(12).toString('hex')}`);
 await writeFile(temp,JSON.stringify(state),{flag:'wx',mode:0o600});
 await rename(temp,path.join(dir,'status.json'));
}
export async function updateStatus():Promise<UpdateStatus>{
 const dir=await workspace();
 try{
  const raw=await readFile(path.join(dir,'status.json'),'utf8');
  if(raw.length>4096)throw new Error('Status ungültig.');
  const data=JSON.parse(raw);
  if(!allowedStates.has(data.state)||typeof data.message!=='string'||data.message.length>500||typeof data.updatedAt!=='string'||!Number.isFinite(Date.parse(data.updatedAt))||(data.commit!==undefined&&!/^[a-f0-9]{40}$/.test(data.commit)))throw new Error('Status ungültig.');
  if(['starting','fetching','patching'].includes(data.state)&&Date.now()-Date.parse(data.updatedAt)>600000)return {state:'unknown',message:'Der letzte Lauf meldet sich nicht mehr. Die Sperre bleibt bestehen; Serverprotokoll und Update-Verzeichnis müssen geprüft werden.',updatedAt:data.updatedAt};
  return {state:data.state,message:data.message,updatedAt:data.updatedAt,...(data.commit?{commit:data.commit}:{})};
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){
  try{await lstat(path.join(dir,'running'));return {state:'unknown',message:'Eine unterbrochene Vorbereitung muss auf dem Server geprüft werden.'};}catch(lockError){if((lockError as NodeJS.ErrnoException).code==='ENOENT')return idle;throw lockError;}
 }throw error;}
}
export class UpdateBusy extends Error {}
export async function startUpdate(recheck?:()=>Promise<boolean>):Promise<void>{
 const dir=await workspace(), lock=path.join(dir,'running');
 try{await mkdir(lock,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new UpdateBusy('Eine Vorbereitung läuft bereits oder wurde unterbrochen.');throw error;}
 try{
  // Preserve candidates for inspection; never silently delete one to reclaim space.
  const {readdir}=await import('node:fs/promises');
  if((await readdir(dir)).filter(name=>/^candidate-[a-f0-9]{24}$/.test(name)).length>=2)throw new Error('Es sind bereits zwei Kandidaten vorhanden. Bitte zuerst auf dem Server prüfen und archivieren.');
  const id=randomBytes(12).toString('hex');
  await writeStatus(dir,{state:'starting',message:'Update-Vorbereitung startet.',updatedAt:new Date().toISOString()});
  const worker=path.join(process.cwd(),'scripts','prepare-haben-update.mjs');
  const patches=path.join(process.cwd(),'apps','buchhaltung','.videomaker','patches');
  if(recheck&&!await recheck())throw new Error('Die Sitzung ist nicht mehr gültig.');
  const child=spawn(process.execPath,[worker,dir,id,patches],{detached:true,stdio:'ignore',env:{NODE_ENV:'production',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:lock,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',SSH_ASKPASS:'/bin/false'}});
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>resolve());});
  child.unref();
 }catch(error){
  await writeStatus(dir,{state:'failed',message:'Vorbereitung konnte nicht gestartet werden.',updatedAt:new Date().toISOString()}).catch(()=>{});
  await rm(lock,{recursive:true,force:true});
  throw error;
 }
}
