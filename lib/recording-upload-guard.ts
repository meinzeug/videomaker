import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,unlinkSync} from 'node:fs';
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

function hostIdentity():{host:string;boot:string} {
 let machineId:string,thisBoot:string;
 try {machineId=readFileSync('/etc/machine-id','utf8').trim();thisBoot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();}
 catch {throw new Error('UPLOAD_HOST_ID_UNAVAILABLE');}
 if(!/^[0-9a-f]{32}$/i.test(machineId)||!/^[0-9a-f-]{36}$/i.test(thisBoot))throw new Error('UPLOAD_HOST_ID_UNAVAILABLE');
 return {host:createHash('sha256').update(hostname()).update('\0').update(machineId).digest('hex'),boot:thisBoot};
}
export function acquireRecordingUpload(database:Database.Database, now:()=>number=monoMs):RecordingLease|null {
 const {host:thisHost,boot:thisBoot}=hostIdentity();
 database.exec('CREATE TABLE IF NOT EXISTS recording_upload_slots (slot INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, host TEXT NOT NULL, boot TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS recording_upload_owners (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, host TEXT NOT NULL, boot TEXT NOT NULL, pid INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS recording_upload_host (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL)');
 const token=randomUUID();const started=now();let nextRenew=0;
 const slot=database.transaction(()=>{
  const time=now();
  database.prepare('INSERT OR IGNORE INTO recording_upload_host(singleton,host) VALUES(1,?)').run(thisHost);
  const bound=database.prepare('SELECT host FROM recording_upload_host WHERE singleton=1').get() as {host:string};
  if(bound.host!==thisHost)throw new Error('UPLOAD_HOST_MISMATCH');
  database.prepare('DELETE FROM recording_upload_slots WHERE host=? AND (boot<>? OR expires_at<=?)').run(thisHost,thisBoot,time);
  for(let index=0;index<LIMIT;index++){
   const inserted=database.prepare('INSERT OR IGNORE INTO recording_upload_slots(slot,token,host,boot,expires_at,reserved_bytes) VALUES(?,?,?,?,?,0)').run(index,token,thisHost,thisBoot,time+LEASE_MS);
   if(inserted.changes===1){database.prepare('INSERT INTO recording_upload_owners(token,created_at,host,boot,pid) VALUES(?,?,?,?,?)').run(token,Date.now(),thisHost,thisBoot,process.pid);nextRenew=time+RENEW_MS;return index;}
  }
  return null;
 })();
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
