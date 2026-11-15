// Synthetic SQLite-only experiment. No file publication, HTTP route or production mutation.
import {createHash} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ticketPattern=/^[A-Za-z0-9_-]{43}$/;
const sha=/^[0-9a-f]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');

/** Fixed synthetic mutation under the same SQLite writer lock as device revoke. */
export function commitSyntheticUpload(db,ticket,project,recording,size,checksum,clock=Date.now){
 if(db.inTransaction)throw Error('outer transaction forbidden');
 if(typeof ticket!=='string'||!ticketPattern.test(ticket)||typeof project!=='string'||!uuid.test(project)||typeof recording!=='string'||!uuid.test(recording)||
    !Number.isSafeInteger(size)||size<=0||typeof checksum!=='string'||!sha.test(checksum))return 'invalid';
 const ticketHash=digest(ticket);
 return db.transaction(()=>{
  const observe=()=>{
   const active=db.inTransaction,now=clock();
   if(!active||db.inTransaction!==active)throw Error('untrusted clock changed transaction');
   const floor=db.prepare('SELECT floor_ms FROM studio_auth_clock WHERE id=1').get()?.floor_ms;
   if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(floor)||now<floor)return null;
   db.prepare('UPDATE studio_auth_clock SET floor_ms=? WHERE id=1').run(now);return now;
  };
  const allowed=now=>{
   if(now===null)return false;
   const row=db.prepare(`SELECT d.capabilities,d.revoked,t.expires_ms FROM studio_auth_tickets t
    JOIN studio_auth_devices d ON d.device_id=t.device_id WHERE t.ticket_hash=?`).get(ticketHash);
   return !!row&&!row.revoked&&now<row.expires_ms&&row.capabilities.split(',').includes('recordings:upload');
  };
  if(!allowed(observe()))return 'denied';
  if(!db.prepare('SELECT 1 FROM fixture_projects WHERE id=?').get(project))return 'missing';
  db.exec('SAVEPOINT fixture_upload_mutation');
  const old=db.prepare('SELECT project_id,size,sha256 FROM fixture_upload_publications WHERE recording_id=?').get(recording);
  let result='created';
  if(old)result=old.project_id===project&&old.size===size&&old.sha256===checksum?'replayed':'conflict';
  else db.prepare('INSERT INTO fixture_upload_publications(recording_id,project_id,size,sha256) VALUES(?,?,?,?)').run(recording,project,size,checksum);
  const finalNow=observe();
  if(!allowed(finalNow)){
   // Keep the later wall-clock observation while discarding the mutation.
   db.exec('ROLLBACK TO fixture_upload_mutation; RELEASE fixture_upload_mutation');
   if(finalNow!==null)db.prepare('UPDATE studio_auth_clock SET floor_ms=MAX(floor_ms,?) WHERE id=1').run(finalNow);
   return 'denied';
  }
  db.exec('RELEASE fixture_upload_mutation');
  return result;
 }).immediate();
}
