import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,ftruncateSync,lstatSync,mkdirSync,openSync,readSync,statfsSync,unlinkSync,writeSync} from 'node:fs';
import path from 'node:path';
import {isRecordingId,MAX_RECORDING_SIZE} from './recordings.ts';
import {RECORDING_DISK_RESERVE} from './recording-upload-guard.ts';
import {syncDirectory} from './recording-upload-intent.ts';

/** Experimental staging only. No route publishes or deletes a finished recording here. */
export const LIVE_CHUNK_BYTES=1024*1024;
export const LIVE_MAX_SESSIONS=8;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sha=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const normal=(value:string)=>value.toLowerCase();
type Session={id:string;project_id:string;recording_id:string;state:'opening'|'open'|'sealed'|'published'|'cancelling';file_key:string;dev:string|null;ino:string|null;final_size:number|null;final_sha256:string|null};
type Chunk={part:number;revision:number;size:number;sha256:string;state:'writing'|'ready';expected_revision:number};
export class LiveStagingError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const fail=(code:string):never=>{throw new LiveStagingError(code);};

/** Explicitly migrated by the caller; never touches existing recordings or project data. */
export function initializeLiveStaging(db:Database.Database):void {
 const durability=db.pragma('synchronous',{simple:true});
 if(typeof durability!=='number'||durability<2)fail('UNSAFE_SQLITE_DURABILITY');
 db.exec(`CREATE TABLE IF NOT EXISTS live_recording_stages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, recording_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('opening','open','sealed','published','cancelling')), file_key TEXT NOT NULL UNIQUE,
  dev TEXT, ino TEXT, final_size INTEGER, final_sha256 TEXT, created_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS live_recording_chunks (
  stage_id TEXT NOT NULL REFERENCES live_recording_stages(id), part INTEGER NOT NULL,
  revision INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('writing','ready')), expected_revision INTEGER NOT NULL,
  PRIMARY KEY(stage_id,part)
 );`);
}

/** Directory, session identities and operations must be protected by the calling route. */
export function createLiveStaging(db:Database.Database,root:string,freeBytes?:(dir:string)=>bigint,authorize:()=>void=()=>{}) {
 const directory=path.join(root,'.live-recording-staging');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const dirStat=lstatSync(directory);
 if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||(dirStat.mode&0o077)!==0||dirStat.uid!==process.getuid?.())fail('UNSAFE_DIRECTORY');
 syncDirectory(root);
 const free=freeBytes??((dir:string)=>{const fs=statfsSync(dir,{bigint:true});return fs.bavail*fs.bsize;});
 const row=(id:string)=>db.prepare('SELECT * FROM live_recording_stages WHERE id=?').get(id) as Session|undefined;
 const filename=(s:Session)=>path.join(directory,`${s.file_key}.part`);
 const openChecked=(s:Session)=>{
  if(!s.dev||!s.ino||!isRecordingId(s.file_key))return fail('INVALID_STAGE');
  const fd=openSync(filename(s),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd,{bigint:true});
  if(!info.isFile()||info.dev.toString()!==s.dev||info.ino.toString()!==s.ino){closeSync(fd);return fail('STAGE_CHANGED');}
  return fd;
 };
 const reserve=(bytes:number)=>{
  const has=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recording_upload_slots'").get();
  const reserved=has?(db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM recording_upload_slots').get() as {n:number}).n:0;
  if(!Number.isSafeInteger(reserved)||reserved<0||free(directory)<RECORDING_DISK_RESERVE+BigInt(reserved)+BigInt(bytes)+16n*1024n*1024n)fail('NO_SPACE');
 };
 const resolveOpening=(id:string)=>{
  const s=row(id);if(!s)return fail('NOT_FOUND');if(s.state!=='opening')return s;
  let fd:number;
  try{fd=openSync(filename(s),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;fd=openSync(filename(s),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  try{
   const info=fstatSync(fd,{bigint:true});if(!info.isFile()||info.size!==0n||(info.mode&0o077n)!==0n)fail('STAGE_CHANGED');
   fsyncSync(fd);syncDirectory(directory);
   db.transaction(()=>{
    authorize();
    const current=row(id);if(!current)return fail('NOT_FOUND');
    if(current.state==='opening')db.prepare("UPDATE live_recording_stages SET state='open',dev=?,ino=? WHERE id=? AND state='opening'").run(info.dev.toString(),info.ino.toString(),id);
    else if(current.dev!==info.dev.toString()||current.ino!==info.ino.toString())fail('STAGE_CHANGED');
   }).immediate();
  }finally{closeSync(fd);}
  return row(id)!;
 };
 const checked=(id:string,project:string,recording:string)=>{
  authorize();
  if(!isRecordingId(id)||!isRecordingId(project)||!isRecordingId(recording))return fail('INVALID_ID');
  const found=row(normal(id));if(!found)return fail('NOT_FOUND');
  if(found.project_id!==normal(project)||found.recording_id!==normal(recording))return fail('BINDING_CONFLICT');
  return found;
 };
 return {
  /** One caller-stable upload ID binds exactly one recording and one project. */
  begin(id:string,project:string,recording:string,createdAt=Date.now()) {
   if(!isRecordingId(id)||!isRecordingId(project)||!isRecordingId(recording)||!Number.isSafeInteger(createdAt))return fail('INVALID_ID');
   id=normal(id);project=normal(project);recording=normal(recording);
   db.transaction(()=>{
    authorize();
    const old=row(id);if(old){if(old.project_id!==project||old.recording_id!==recording)fail('BINDING_CONFLICT');return;}
    if(db.prepare('SELECT 1 FROM live_recording_stages WHERE recording_id=?').get(recording))fail('BINDING_CONFLICT');
    if((db.prepare("SELECT COUNT(*) AS n FROM live_recording_stages WHERE state<>'published'").get() as {n:number}).n>=LIVE_MAX_SESSIONS)fail('CAPACITY');
    reserve(0);db.prepare("INSERT INTO live_recording_stages(id,project_id,recording_id,state,file_key,created_at) VALUES(?,?,?,'opening',?,?)").run(id,project,recording,randomUUID(),createdAt);
   }).immediate();
   return resolveOpening(id);
  },
  status(id:string,project:string,recording:string,after=-1,limit=16){
   if(!Number.isSafeInteger(after)||after< -1||!Number.isSafeInteger(limit)||limit<1||limit>64)return fail('INVALID_PAGE');
   return db.transaction(()=>{
    const s=checked(id,project,recording);
    const chunks=db.prepare('SELECT part,revision,size,sha256,state,expected_revision FROM live_recording_chunks WHERE stage_id=? AND part>? ORDER BY part LIMIT ?').all(s.id,after,limit+1) as Chunk[];
    const page=chunks.slice(0,limit),fd=page.some(c=>c.state==='ready')?openChecked(s):null;
    try{
     const verified=page.map(chunk=>{
      if(chunk.state!=='ready'||fd===null)return chunk;
      const bytes=Buffer.alloc(chunk.size);let read=0;
      while(read<bytes.length){const n=readSync(fd,bytes,read,bytes.length-read,chunk.part*LIVE_CHUNK_BYTES+read);if(!n)break;read+=n;}
      return read===bytes.length&&digest(bytes)===chunk.sha256?chunk:{...chunk,state:'invalid' as const};
     });
     return {state:s.state,finalSize:s.final_size,finalSha256:s.final_sha256,chunks:verified,hasMore:chunks.length>limit};
    }finally{if(fd!==null)closeSync(fd);}
   }).immediate();
  },
  /** An acknowledged revision is durable. An interrupted write remains 'writing' and must be resent. */
  put(id:string,project:string,recording:string,part:number,expectedRevision:number,bytes:Buffer,expectedSha:string){
   const s=checked(id,project,recording);
   if(!Number.isSafeInteger(part)||part<0||part>=Math.ceil(MAX_RECORDING_SIZE/LIVE_CHUNK_BYTES)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>LIVE_CHUNK_BYTES||!sha(expectedSha)||digest(bytes)!==expectedSha)return fail('INVALID_CHUNK');
   const pending=db.transaction(()=>{
    const current=checked(id,project,recording);if(current.state!=='open')return fail('NOT_OPEN');
    const last=db.prepare('SELECT part,size FROM live_recording_chunks WHERE stage_id=? ORDER BY part DESC LIMIT 1').get(current.id) as {part:number;size:number}|undefined;
    if(part>(last?.part??-1)+1||last&&part===last.part+1&&last.size!==LIVE_CHUNK_BYTES)fail('NONCONTIGUOUS');
    if(last&&part<last.part&&bytes.length!==LIVE_CHUNK_BYTES)fail('INVALID_CHUNK');
    const old=db.prepare('SELECT * FROM live_recording_chunks WHERE stage_id=? AND part=?').get(current.id,part) as Chunk|undefined;
    if(old?.state==='ready'&&old.revision===expectedRevision+1&&old.sha256===expectedSha&&old.size===bytes.length)return 'done';
    if(old?.state==='writing'){
     if(old.expected_revision!==expectedRevision)fail('REVISION_CONFLICT');
     // An interrupted write may no longer be reconstructible after MP4 rewrites.
     // Replace only its still-uncommitted intent, never an acknowledged revision.
     if(old.sha256!==expectedSha||old.size!==bytes.length){
      reserve(bytes.length);
      db.prepare("UPDATE live_recording_chunks SET size=?,sha256=? WHERE stage_id=? AND part=? AND state='writing'").run(bytes.length,expectedSha,current.id,part);
     }
     return 'write';
    }
    if((old?.revision??0)!==expectedRevision)fail('REVISION_CONFLICT');
    reserve(bytes.length);
    db.prepare(`INSERT INTO live_recording_chunks(stage_id,part,revision,size,sha256,state,expected_revision) VALUES(?,?,?,?,?,'writing',?)
     ON CONFLICT(stage_id,part) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,state='writing',expected_revision=excluded.expected_revision`).run(current.id,part,expectedRevision,bytes.length,expectedSha,expectedRevision);
    return 'write';
   }).immediate();
   if(pending==='done')return {revision:expectedRevision+1,sha256:expectedSha};
   return db.transaction(()=>{
    const current=checked(id,project,recording);if(current.state!=='open')return fail('NOT_OPEN');
    const chunk=db.prepare('SELECT * FROM live_recording_chunks WHERE stage_id=? AND part=?').get(current.id,part) as Chunk|undefined;
    if(chunk?.state==='ready'&&chunk.revision===expectedRevision+1&&chunk.sha256===expectedSha&&chunk.size===bytes.length)return {revision:chunk.revision,sha256:expectedSha};
    if(!chunk||chunk.state!=='writing'||chunk.expected_revision!==expectedRevision||chunk.sha256!==expectedSha||chunk.size!==bytes.length)return fail('REVISION_CONFLICT');
    reserve(bytes.length);const fd=openChecked(current);
    try{let written=0;while(written<bytes.length){const n=writeSync(fd,bytes,written,bytes.length-written,part*LIVE_CHUNK_BYTES+written);if(n<=0)fail('WRITE_FAILED');written+=n;}fsyncSync(fd);}finally{closeSync(fd);}
    db.prepare("UPDATE live_recording_chunks SET state='ready',revision=? WHERE stage_id=? AND part=? AND state='writing'").run(expectedRevision+1,current.id,part);
    return {revision:expectedRevision+1,sha256:expectedSha};
   }).immediate();
  },
  /** Re-read every actual byte; only an exact full-file SHA and contiguous ledger may be sealed. */
  seal(id:string,project:string,recording:string,size:number,expectedSha:string){
   if(!Number.isSafeInteger(size)||size<=0||size>MAX_RECORDING_SIZE||!sha(expectedSha))return fail('INVALID_FINAL');
   return db.transaction(()=>{
    const s=checked(id,project,recording);if(s.state==='opening'||s.state==='cancelling'||s.state==='published')return fail('NOT_OPEN');
    if(s.state==='sealed'&&(s.final_size!==size||s.final_sha256!==expectedSha))return fail('FINAL_CONFLICT');
    const chunks=db.prepare('SELECT * FROM live_recording_chunks WHERE stage_id=? ORDER BY part').all(s.id) as Chunk[];
    if(chunks.length!==Math.ceil(size/LIVE_CHUNK_BYTES))return fail('INCOMPLETE');
    const fd=openChecked(s),hash=createHash('sha256');
    try{
     const buf=Buffer.alloc(LIVE_CHUNK_BYTES);
     for(let i=0;i<chunks.length;i++){
      const chunk=chunks[i],length=Math.min(LIVE_CHUNK_BYTES,size-i*LIVE_CHUNK_BYTES);
      if(chunk.part!==i||chunk.state!=='ready'||chunk.size!==length)fail('INCOMPLETE');
      let read=0;while(read<length){const n=readSync(fd,buf,read,length-read,i*LIVE_CHUNK_BYTES+read);if(!n)fail('STAGE_CHANGED');read+=n;}
      const bytes=buf.subarray(0,length);if(digest(bytes)!==chunk.sha256)fail('STAGE_CHANGED');hash.update(bytes);
     }
     if(hash.digest('hex')!==expectedSha)fail('FINAL_MISMATCH');
     ftruncateSync(fd,size);fsyncSync(fd);
    }finally{closeSync(fd);}
    db.prepare("UPDATE live_recording_stages SET state='sealed',final_size=?,final_sha256=? WHERE id=?").run(size,expectedSha,s.id);
    return {sizeBytes:size,sha256:expectedSha};
   }).immediate();
  },
  /** Only for a verified, sealed recording; the calling transaction must recheck before publishing. */
  sealedPath(id:string,project:string,recording:string){
   const s=checked(id,project,recording);if(s.state!=='sealed'||!s.final_size||!s.final_sha256)return fail('NOT_SEALED');
   const fd=openChecked(s);try{if(fstatSync(fd).size!==s.final_size)fail('STAGE_CHANGED');}finally{closeSync(fd);}
   return {path:filename(s),sizeBytes:s.final_size,sha256:s.final_sha256,dev:s.dev!,ino:s.ino!};
  },
  /** Cancellation applies only to an unpublished staging file, and is restartable. */
  cancel(id:string,project:string,recording:string){
   db.transaction(()=>{
    const s=checked(id,project,recording);if(s.state==='published')fail('PUBLISHED');
    if(s.state==='sealed'){
     if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_recordings'").get()&&db.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE').get(s.id))fail('PUBLISHED');
     const destination=path.join(root,'recordings',`${s.id}.mp4`),marker=path.join(root,'recordings',`.upload-intent-${s.id}.json`);
     if(existsSync(destination)||existsSync(marker))fail('PUBLISH_UNCERTAIN');
    }
    if(s.state!=='cancelling')db.prepare("UPDATE live_recording_stages SET state='cancelling' WHERE id=?").run(s.id);
   }).immediate();
   return db.transaction(()=>{
    const s=checked(id,project,recording);if(s.state!=='cancelling')return fail('INVALID_STAGE');
    try{
     const fd=openSync(filename(s),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
     try{const info=fstatSync(fd,{bigint:true});if(!info.isFile()||(s.dev!==null&&(info.dev.toString()!==s.dev||info.ino.toString()!==s.ino)))fail('STAGE_CHANGED');}finally{closeSync(fd);}
     unlinkSync(filename(s));syncDirectory(directory);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    db.prepare('DELETE FROM live_recording_chunks WHERE stage_id=?').run(s.id);
    db.prepare('DELETE FROM live_recording_stages WHERE id=?').run(s.id);
    return true;
   }).immediate();
  },
  /** Called after the existing recording row and matching hardlink are durable. */
  markPublished(id:string,project:string,recording:string){
   return db.transaction(()=>{
    const s=checked(id,project,recording);if(s.state==='published')return true;if(s.state!=='sealed')return fail('NOT_SEALED');
    const saved=db.prepare('SELECT project_id,mime,size FROM project_recordings WHERE id=?').get(s.id) as {project_id:string;mime:string;size:number}|undefined;
    if(!saved||saved.project_id!==s.project_id||saved.mime!=='video/mp4'||saved.size!==s.final_size)return fail('PUBLISH_UNCERTAIN');
    const target=path.join(root,'recordings',`${s.id}.mp4`),fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const info=fstatSync(fd,{bigint:true});if(!info.isFile()||info.dev.toString()!==s.dev||info.ino.toString()!==s.ino||info.size!==BigInt(saved.size))fail('PUBLISH_UNCERTAIN');}finally{closeSync(fd);}
    try{unlinkSync(filename(s));syncDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    db.prepare('DELETE FROM live_recording_chunks WHERE stage_id=?').run(s.id);
    db.prepare("UPDATE live_recording_stages SET state='published' WHERE id=? AND state='sealed'").run(s.id);
    return true;
   }).immediate();
  },
 };
}
