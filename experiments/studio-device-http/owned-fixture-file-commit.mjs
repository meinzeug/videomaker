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
export function commitOwnedSyntheticFile(db,{root,ticket,project,recording,bytes,clock=Date.now,crashAfterLink=false,crashAfterCommit=false}){
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
    const floor=db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock WHERE id=1').get()?.floor_ms;
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(floor)||now<floor)return null;
    db.prepare('UPDATE fixture_owned_auth_clock SET floor_ms=? WHERE id=1').run(now);return now;
   };
   const allowed=now=>{
    if(now===null)return null;
    const row=db.prepare(`SELECT d.capabilities,d.revoked,t.expires_ms,g.revoked AS grant_revoked,p.owner_hash,p.workspace_hash,p.project_epoch
     FROM fixture_owned_auth_tickets t JOIN fixture_owned_auth_devices d ON d.device_id=t.device_id
     JOIN fixture_owned_auth_grants g ON g.device_id=d.device_id AND g.project_id=? AND g.owner_hash=d.owner_hash AND g.workspace_hash=d.workspace_hash
     JOIN fixture_owned_auth_projects p ON p.project_id=g.project_id AND p.owner_hash=g.owner_hash AND p.workspace_hash=g.workspace_hash AND p.project_epoch=g.project_epoch
     WHERE t.ticket_hash=?`).get(project,ticketHash);
    return row&&!row.revoked&&!row.grant_revoked&&now<row.expires_ms&&row.capabilities.split(',').includes('recordings:upload')?row:null;
   };
   const initial=allowed(observe());if(!initial)return 'denied';
   const sameBinding=row=>!!row&&row.owner_hash===initial.owner_hash&&row.workspace_hash===initial.workspace_hash&&row.project_epoch===initial.project_epoch;
   if(db.prepare('SELECT 1 FROM fixture_file_tombstones WHERE recording_id=?').get(recording))return 'deleted';
   const previous=db.prepare('SELECT project_id,size,sha256,owner_hash,workspace_hash,project_epoch FROM fixture_file_publications WHERE recording_id=?').get(recording);
   if(previous){
    if(previous.project_id!==project||previous.size!==bytes.length||previous.sha256!==hash||!sameBinding(previous))return 'conflict';
    if(!existsSync(target)||!lstatSync(target).isFile()||digest(readFileSync(target))!==hash)return 'uncertain';
    const finalNow=observe();
    if(!sameBinding(allowed(finalNow)))return 'denied';
    const current=db.prepare('SELECT project_id,size,sha256,owner_hash,workspace_hash,project_epoch FROM fixture_file_publications WHERE recording_id=?').get(recording);
    if(db.prepare('SELECT 1 FROM fixture_file_tombstones WHERE recording_id=?').get(recording)||
       !current||current.project_id!==project||current.size!==bytes.length||current.sha256!==hash||!sameBinding(current)||
       !existsSync(target)||!lstatSync(target).isFile()||digest(readFileSync(target))!==hash)return 'uncertain';
    return 'replayed';
   }
   if(existsSync(target))return 'uncertain';
   const original=lstatSync(stage,{bigint:true});
   linkSync(stage,target);syncDir(root);
   const linked=lstatSync(target,{bigint:true});
   if(!linked.isFile()||linked.dev!==original.dev||linked.ino!==original.ino||linked.size!==BigInt(bytes.length)||digest(readFileSync(target))!==hash)return 'uncertain';
   // Only the synthetic child test passes this flag, never production code.
   if(crashAfterLink)process.kill(process.pid,'SIGKILL');
   db.exec('SAVEPOINT fixture_file_mutation');
   const inserted=db.prepare('INSERT INTO fixture_file_publications(recording_id,project_id,size,sha256,owner_hash,workspace_hash,project_epoch) VALUES(?,?,?,?,?,?,?)').run(recording,project,bytes.length,hash,initial.owner_hash,initial.workspace_hash,initial.project_epoch);
   const finalNow=observe();
   const current=db.prepare('SELECT rowid,project_id,size,sha256,owner_hash,workspace_hash,project_epoch FROM fixture_file_publications WHERE recording_id=?').get(recording);
   const ourRow=!!current&&current.rowid===inserted.lastInsertRowid&&current.project_id===project&&current.size===bytes.length&&current.sha256===hash&&sameBinding(current);
   const finalGrant=allowed(finalNow),projectPresent=sameBinding(finalGrant);
   const deleted=!!db.prepare('SELECT 1 FROM fixture_file_tombstones WHERE recording_id=?').get(recording);
   let ownLink=false;
   try{const present=lstatSync(target,{bigint:true});ownLink=present.isFile()&&present.dev===linked.dev&&present.ino===linked.ino&&present.size===BigInt(bytes.length)&&digest(readFileSync(target))===hash;}catch(error){if(error?.code!=='ENOENT')throw error;}
   if(!projectPresent||!ourRow||deleted||!ownLink){
    // Remove only the exact row and link this call created. Preserve a
    // reentrant tombstone/project mutation and any unrecognised file/row.
    if(ourRow){
     db.prepare('DELETE FROM fixture_file_publications WHERE rowid=? AND recording_id=?').run(current.rowid,recording);
     if(ownLink){unlinkSync(target);syncDir(root);}
    }
    db.exec('RELEASE fixture_file_mutation');
    if(!ourRow||!ownLink)return 'uncertain';
    return deleted?'deleted':'denied';
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
