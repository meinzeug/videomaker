// Synthetic /dev/shm-only file/SQLite experiment; never import in production.
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fsyncSync,linkSync,lstatSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const syncDir=dir=>{const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}};
function rootCheck(root){
 if(typeof root!=='string'||dirname(root)!=='/dev/shm'||!/^studio-file-commit\.[A-Za-z0-9]+$/.test(basename(root))||realpathSync(root)!==root||
    readFileSync(join(root,'.fixture'),'utf8')!=='synthetic-device-file-commit\n')throw Error('invalid fixture root');
}

/** Fixed small synthetic bytes only. A crash orphan is never adopted automatically. */
export function commitSyntheticFile(db,{root,ticket,project,recording,bytes,clock=Date.now,crashAfterLink=false,crashAfterCommit=false}){
 rootCheck(root);
 if(db.inTransaction)throw Error('outer transaction forbidden');
 if(typeof ticket!=='string'||!tokenPattern.test(ticket)||typeof project!=='string'||!uuid.test(project)||
    typeof recording!=='string'||!uuid.test(recording)||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>65536)return 'invalid';
 const hash=digest(bytes),ticketHash=digest(ticket),stage=join(root,`stage-${randomUUID()}`),target=join(root,`${recording}.fixture`);
 const fd=openSync(stage,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 try{
  const result=db.transaction(()=>{
   const observe=()=>{
    const active=db.inTransaction,now=clock();if(!active||active!==db.inTransaction)throw Error('untrusted clock changed transaction');
    const floor=db.prepare('SELECT floor_ms FROM studio_auth_clock WHERE id=1').get()?.floor_ms;
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(floor)||now<floor)return null;
    db.prepare('UPDATE studio_auth_clock SET floor_ms=? WHERE id=1').run(now);return now;
   };
   const allowed=now=>{
    if(now===null)return false;
    const row=db.prepare(`SELECT d.capabilities,d.revoked,t.expires_ms FROM studio_auth_tickets t JOIN studio_auth_devices d ON d.device_id=t.device_id WHERE t.ticket_hash=?`).get(ticketHash);
    return !!row&&!row.revoked&&now<row.expires_ms&&row.capabilities.split(',').includes('recordings:upload');
   };
   if(!allowed(observe()))return 'denied';
   if(!db.prepare('SELECT 1 FROM fixture_projects WHERE id=?').get(project))return 'missing';
   if(db.prepare('SELECT 1 FROM fixture_file_tombstones WHERE recording_id=?').get(recording))return 'deleted';
   const previous=db.prepare('SELECT project_id,size,sha256 FROM fixture_file_publications WHERE recording_id=?').get(recording);
   if(previous){
    if(previous.project_id!==project||previous.size!==bytes.length||previous.sha256!==hash)return 'conflict';
    if(!existsSync(target)||!lstatSync(target).isFile()||digest(readFileSync(target))!==hash)return 'uncertain';
    return allowed(observe())?'replayed':'denied';
   }
   if(existsSync(target))return 'uncertain';
   const original=lstatSync(stage,{bigint:true});
   linkSync(stage,target);syncDir(root);
   const linked=lstatSync(target,{bigint:true});
   if(!linked.isFile()||linked.dev!==original.dev||linked.ino!==original.ino||linked.size!==BigInt(bytes.length)||digest(readFileSync(target))!==hash)return 'uncertain';
   // Only the synthetic child test passes this flag, never production code.
   if(crashAfterLink)process.kill(process.pid,'SIGKILL');
   db.exec('SAVEPOINT fixture_file_mutation');
   db.prepare('INSERT INTO fixture_file_publications(recording_id,project_id,size,sha256) VALUES(?,?,?,?)').run(recording,project,bytes.length,hash);
   const finalNow=observe();
   if(!allowed(finalNow)){
    db.exec('ROLLBACK TO fixture_file_mutation; RELEASE fixture_file_mutation');
    if(finalNow!==null)db.prepare('UPDATE studio_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
    const current=lstatSync(target,{bigint:true});
    if(current.dev!==linked.dev||current.ino!==linked.ino)return 'uncertain';
    unlinkSync(target);syncDir(root);return 'denied';
   }
   db.exec('RELEASE fixture_file_mutation');return 'created';
  }).immediate();
  if(crashAfterCommit&&result==='created')process.kill(process.pid,'SIGKILL');
  return result;
 }finally{
  // This path was created exclusively by this call, never by a phone/user.
  try{unlinkSync(stage);}catch(error){if(error?.code!=='ENOENT')throw error;}
 }
}
