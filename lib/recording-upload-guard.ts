import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,readlinkSync,unlinkSync} from 'node:fs';
import {readdir,lstat,statfs} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';

const LIMIT=2, LEASE_MS=45_000, RENEW_MS=5_000, TOTAL_MS=12*60*60_000, STALE_GRACE_MS=5*60_000;
// Linux monotonic clock is shared by all workers on the same boot; a different
// host is never assumed dead. A same-host reboot invalidates old ownership.
const monoMs=()=>Number(process.hrtime.bigint()/1_000_000n);
export const RECORDING_DISK_RESERVE=512n*1024n*1024n;
export const RECORDING_READ_TIMEOUT_MS=30_000;
export type RecordingLease={token:string;check:()=>void;reserve:(bytes:number,freeBytes:bigint)=>void;release:()=>void};

export function parseProcStartTime(value:string,expectedPid?:number):string|null {
 const match=/^(\d+) \(/.exec(value),end=value.lastIndexOf(')');if(!match||end<0||(expectedPid!==undefined&&match[1]!==String(expectedPid)))return null;
 const fields=value.slice(end+1).trim().split(/\s+/);const start=fields[19];
 return fields.length>=20&&/^[1-9][0-9]*$/.test(start)?start:null;
}
function hostIdentity():{host:string;boot:string;pidns:string;processStart:string} {
 let machineId:string,thisBoot:string,pidns:string,processStart:string|null;
 try {machineId=readFileSync('/etc/machine-id','utf8').trim();thisBoot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();pidns=readlinkSync('/proc/self/ns/pid');processStart=parseProcStartTime(readFileSync('/proc/self/stat','utf8'),process.pid);}
 catch {throw new Error('UPLOAD_HOST_ID_UNAVAILABLE');}
 if(!/^[0-9a-f]{32}$/i.test(machineId)||!/^[0-9a-f-]{36}$/i.test(thisBoot)||!/^pid:\[\d+\]$/.test(pidns)||!processStart)throw new Error('UPLOAD_HOST_ID_UNAVAILABLE');
 return {host:createHash('sha256').update(hostname()).update('\0').update(machineId).digest('hex'),boot:thisBoot,pidns,processStart};
}
export function acquireRecordingUpload(database:Database.Database, now:()=>number=monoMs):RecordingLease|null {
 const {host:thisHost,boot:thisBoot,pidns:thisPidns,processStart:thisStart}=hostIdentity();
 database.exec("CREATE TABLE IF NOT EXISTS recording_upload_slots (slot INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, host TEXT NOT NULL, boot TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS recording_upload_owners (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, host TEXT NOT NULL, boot TEXT NOT NULL, pid INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, pidns TEXT NOT NULL DEFAULT '', process_start TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS recording_upload_host (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL)");
 const token=randomUUID();const started=now();let nextRenew=0;
 const slot=database.transaction(()=>{
  const columns=database.prepare('PRAGMA table_info(recording_upload_owners)').all() as {name:string}[];
  if(!columns.some(column=>column.name==='pidns'))database.exec("ALTER TABLE recording_upload_owners ADD COLUMN pidns TEXT NOT NULL DEFAULT ''");
  if(!columns.some(column=>column.name==='process_start'))database.exec("ALTER TABLE recording_upload_owners ADD COLUMN process_start TEXT NOT NULL DEFAULT ''");
  const time=now();
  database.prepare('INSERT OR IGNORE INTO recording_upload_host(singleton,host) VALUES(1,?)').run(thisHost);
  const bound=database.prepare('SELECT host FROM recording_upload_host WHERE singleton=1').get() as {host:string};
  if(bound.host!==thisHost)throw new Error('UPLOAD_HOST_MISMATCH');
  database.prepare('DELETE FROM recording_upload_slots WHERE host=? AND (boot<>? OR expires_at<=?)').run(thisHost,thisBoot,time);
  for(let index=0;index<LIMIT;index++){
   const inserted=database.prepare('INSERT OR IGNORE INTO recording_upload_slots(slot,token,host,boot,expires_at,reserved_bytes) VALUES(?,?,?,?,?,0)').run(index,token,thisHost,thisBoot,time+LEASE_MS);
   if(inserted.changes===1){database.prepare('INSERT INTO recording_upload_owners(token,created_at,host,boot,pid,pidns,process_start) VALUES(?,?,?,?,?,?,?)').run(token,Date.now(),thisHost,thisBoot,process.pid,thisPidns,thisStart);nextRenew=time+RENEW_MS;return index;}
  }
  return null;
 }).immediate();
 if(slot===null)return null;
 const check=()=>{
  const time=now();if(time-started>TOTAL_MS||time<started)throw new Error('UPLOAD_TIMEOUT');
  const row=database.prepare('SELECT expires_at FROM recording_upload_slots WHERE slot=? AND token=? AND host=? AND boot=?').get(slot,token,thisHost,thisBoot) as {expires_at:number}|undefined;
  if(!row||row.expires_at<=time)throw new Error('UPLOAD_LEASE_LOST');
  if(time>=nextRenew){const changed=database.prepare('UPDATE recording_upload_slots SET expires_at=? WHERE slot=? AND token=? AND expires_at>?').run(time+LEASE_MS,slot,token,time);if(changed.changes!==1)throw new Error('UPLOAD_LEASE_LOST');nextRenew=time+RENEW_MS;}
 };
 return {
  token,check,
  reserve:(bytes,freeBytes)=>database.transaction(()=>{
   check();
   if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('UPLOAD_NO_SPACE');
   const row=database.prepare('SELECT COALESCE(SUM(reserved_bytes),0) AS total FROM recording_upload_slots WHERE token<>?').get(token) as {total:number};
   if(freeBytes<RECORDING_DISK_RESERVE+BigInt(row.total)+BigInt(bytes))throw new Error('UPLOAD_NO_SPACE');
   database.prepare('UPDATE recording_upload_slots SET reserved_bytes=? WHERE slot=? AND token=?').run(bytes,slot,token);
  })(),
  release:()=>database.transaction(()=>{database.prepare('DELETE FROM recording_upload_slots WHERE slot=? AND token=?').run(slot,token);database.prepare('UPDATE recording_upload_owners SET completed=1 WHERE token=?').run(token);})(),
 };
}

/** Conservative: an expired lease alone cannot prove asynchronous writes stopped. */
export function recordingUploadOwnerDefinitelyStopped(database:Database.Database,token:string):boolean {
 if(database.prepare('SELECT 1 FROM recording_upload_slots WHERE token=?').get(token))return false;
 const row=database.prepare('SELECT host,boot,pid,pidns,process_start AS processStart,completed FROM recording_upload_owners WHERE token=?').get(token) as {host:string;boot:string;pid:number;pidns:string;processStart:string;completed:number}|undefined;
 if(!row)return false;
 if(row.completed===1)return true;
 let identity:ReturnType<typeof hostIdentity>;try{identity=hostIdentity();}catch{return false;}
 if(row.host!==identity.host)return false;
 if(row.boot!==identity.boot)return true;
 if(!row.pidns||row.pidns!==identity.pidns||!Number.isSafeInteger(row.pid)||row.pid<=0||!/^[1-9][0-9]*$/.test(row.processStart))return false;
 try{process.kill(row.pid,0);}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
 try{const current=parseProcStartTime(readFileSync(`/proc/${row.pid}/stat`,'utf8'),row.pid);return !!current&&current!==row.processStart;}catch{return false;}
}

export async function recordingFreeBytes(directory:string):Promise<bigint> {
 const info=await statfs(directory,{bigint:true});return info.bavail*info.bsize;
}
export async function requireRecordingSpace(directory:string,neededBytes:number):Promise<void> {
 if(!Number.isSafeInteger(neededBytes)||neededBytes<0||(await recordingFreeBytes(directory))<RECORDING_DISK_RESERVE+BigInt(neededBytes))throw new Error('UPLOAD_NO_SPACE');
}
/** Only remove our own expired, old temporaries. Unknown files are never touched. */
export async function cleanupStaleRecordingUploads(database:Database.Database,directory:string):Promise<void> {
 const identity=hostIdentity();
 const names=await readdir(directory);
 for(const name of names){
  const match=/^\.verified-(?:upload|intent-tmp)-([0-9a-f-]{36})$/.exec(name);if(!match)continue;
  const file=path.join(directory,name);let age:number;let identity:{dev:number;ino:number;size:number;mtimeMs:number};
  try{const item=await lstat(file);if(!item.isFile())continue;age=Date.now()-item.mtimeMs;identity=item;}catch{continue;}
  if(age<STALE_GRACE_MS)continue;
  database.transaction(()=>{
   const owned=database.prepare('SELECT 1 FROM recording_upload_owners WHERE token=?').get(match[1]);
   const active=database.prepare('SELECT 1 FROM recording_upload_slots WHERE token=?').get(match[1]);
   if(!owned||active)return;
   try{const current=lstatSync(file);if(current.isFile()&&current.dev===identity.dev&&current.ino===identity.ino&&current.size===identity.size&&current.mtimeMs===identity.mtimeMs)unlinkSync(file);}catch{/* leave unfamiliar or concurrently changed files untouched */}
  })();
 }
 const owners=database.prepare('SELECT token,completed,host,boot,pid FROM recording_upload_owners WHERE token NOT IN (SELECT token FROM recording_upload_slots) LIMIT 100').all() as Array<{token:string;completed:number;host:string;boot:string;pid:number}>;
 for(const owner of owners){
  const cameraLocks=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_project_upload_locks'").get();
  if(cameraLocks&&database.prepare('SELECT 1 FROM camera_project_upload_locks WHERE token=?').get(owner.token))continue;
  if(names.includes(`.verified-upload-${owner.token}`)||names.includes(`.verified-intent-tmp-${owner.token}`))continue;
  let knownFinished=owner.completed===1;
  if(!knownFinished&&owner.host===identity.host){
   if(owner.boot!==identity.boot)knownFinished=true;
   else try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')knownFinished=true;}
  }
  if(knownFinished)database.prepare('DELETE FROM recording_upload_owners WHERE token=? AND token NOT IN (SELECT token FROM recording_upload_slots)').run(owner.token);
 }
}
export async function readRecordingChunk(reader:ReadableStreamDefaultReader<Uint8Array>,timeoutMs=RECORDING_READ_TIMEOUT_MS):Promise<ReadableStreamReadResult<Uint8Array>> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {return await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('UPLOAD_TIMEOUT')),timeoutMs);})]);}
 catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally {if(timer!==undefined)clearTimeout(timer);}
}
