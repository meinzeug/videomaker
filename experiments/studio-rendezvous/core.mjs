import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

// Isolated, server-trusted signaling fixture. No public route or production migration.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/,ROOM_TTL=2*60*60_000,JOIN_TTL=60_000,MAX_ROOMS=64,MAX_OWNER=2,MAX_CHUNK=16384,MAX_QUEUED=262144,MAX_MESSAGES=16,MAX_TOTAL=8*1024*1024;
const sha=x=>createHash('sha256').update(x).digest('hex');
const deny=()=>{throw Error('STUDIO_RENDEZVOUS_DENIED');};
function fixture(db){if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE!=='1')throw Error('STUDIO_RENDEZVOUS_FIXTURE_DISABLED');if(!db||typeof db.transaction!=='function'||db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('INVALID_DB');}
function clockNow(clock){const c=clock();if(!c||!UUID.test(c.runtimeId)||!Number.isSafeInteger(c.wall)||!Number.isSafeInteger(c.tick)||c.wall<0||c.tick<0)deny();return c;}
function fresh(row,c,ttl=ROOM_TTL){return row.runtime_id===c.runtimeId&&c.wall>=row.created_wall&&c.tick>=row.created_tick&&c.wall-row.created_wall<ttl&&c.tick-row.created_tick<ttl;}
function secretHash(code){if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code))return null;const b=Buffer.from(code,'base64url');return b.length===32&&b.toString('base64url')===code?sha(b):null;}
function equalHash(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===64&&b.length===64&&timingSafeEqual(Buffer.from(a,'ascii'),Buffer.from(b,'ascii'));}
function checkArgs(owner,session,device){if(!HEX.test(owner)||!HEX.test(session)||!UUID.test(device))deny();}
function bound(row,owner,session,role,device){return row&&row.owner_hash===owner&&row.closed===0&&['camera','prompter'].includes(role)&&row[role+'_session']===session&&row[role+'_device']===device;}
function authorize(auth,owner,session){try{return typeof auth==='function'&&auth(owner,session)===true;}catch{return false;}}
function same(row,other){return row&&other&&['room_id','owner_hash','camera_session','camera_device','prompter_session','prompter_device','ticket_hash','secret_epoch','runtime_id','created_wall','created_tick','camera_approved','prompter_approved','closed','camera_next','prompter_next','camera_acked','prompter_acked','camera_last_hash','prompter_last_hash','camera_total','prompter_total'].every(k=>row[k]===other[k]);}
function failed(db,row){db.prepare('UPDATE studio_signal_rooms SET closed=1 WHERE room_id=?').run(row.room_id);db.prepare('DELETE FROM studio_signal_messages WHERE room_id=?').run(row.room_id);return null;}
function current(db,row,clock,auth){
 const first=clockNow(clock);if(!fresh(row,first))return failed(db,row);
 if(!authorize(auth,row.owner_hash,row.camera_session)||(row.prompter_session&&!authorize(auth,row.owner_hash,row.prompter_session)))return failed(db,row);
 let latest=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(row.room_id);const second=clockNow(clock);
 if(!same(row,latest)||!fresh(row,second))return failed(db,row);
 // Both sessions are checked once more after any reentrant clock callbacks.
 if(!authorize(auth,row.owner_hash,row.camera_session)||(row.prompter_session&&!authorize(auth,row.owner_hash,row.prompter_session)))return failed(db,row);
 latest=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(row.room_id);if(!same(row,latest))return failed(db,row);return latest;
}
function transaction(db,fn){const value=db.transaction(fn).immediate();if(value===null)deny();return value;}
export function initializeStudioRendezvousFixture(db){fixture(db);db.exec(`
 CREATE TABLE IF NOT EXISTS studio_signal_rooms(room_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,camera_session TEXT NOT NULL,camera_device TEXT NOT NULL,prompter_session TEXT,prompter_device TEXT,ticket_hash TEXT NOT NULL UNIQUE,secret_epoch TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,camera_approved INTEGER NOT NULL DEFAULT 0,prompter_approved INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,camera_next INTEGER NOT NULL DEFAULT 1,prompter_next INTEGER NOT NULL DEFAULT 1,camera_acked INTEGER NOT NULL DEFAULT 0,prompter_acked INTEGER NOT NULL DEFAULT 0,camera_last_hash TEXT,prompter_last_hash TEXT,camera_total INTEGER NOT NULL DEFAULT 0,prompter_total INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS studio_signal_messages(room_id TEXT NOT NULL,source TEXT NOT NULL,sequence INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(room_id,source,sequence),FOREIGN KEY(room_id) REFERENCES studio_signal_rooms(room_id) ON DELETE CASCADE);
`);}
export function createStudioRoomFixture(db,{ownerHash,sessionHash,deviceId},serverSecret,clock,auth){
 fixture(db);if(!Buffer.isBuffer(serverSecret)||serverSecret.length<32)deny();checkArgs(ownerHash,sessionHash,deviceId);
 return transaction(db,()=>{
  if(!authorize(auth,ownerHash,sessionHash))return null;const now=clockNow(clock);
  // Closed and expired rooms are removed only within the same runtime; restart handling remains explicit.
  db.prepare('DELETE FROM studio_signal_rooms WHERE runtime_id=? AND (closed=1 OR created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(now.runtimeId,now.wall,now.tick,now.wall-ROOM_TTL,now.tick-ROOM_TTL);
  if(db.prepare('SELECT count(*) n FROM studio_signal_rooms').get().n>=MAX_ROOMS||db.prepare('SELECT count(*) n FROM studio_signal_rooms WHERE owner_hash=?').get(ownerHash).n>=MAX_OWNER)return null;
  const roomId=randomUUID(),code=randomBytes(32).toString('base64url'),epoch=createHmac('sha256',serverSecret).update('studio-signaling-epoch/v1').digest('hex');
  db.prepare('INSERT INTO studio_signal_rooms(room_id,owner_hash,camera_session,camera_device,ticket_hash,secret_epoch,runtime_id,created_wall,created_tick) VALUES(?,?,?,?,?,?,?,?,?)').run(roomId,ownerHash,sessionHash,deviceId,secretHash(code),epoch,now.runtimeId,now.wall,now.tick);
  const row=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);
  if(!current(db,row,clock,auth))return null;return {roomId,joinCode:code,expiresInMs:JOIN_TTL};
 });
}
export function joinStudioRoomFixture(db,{ownerHash,sessionHash,deviceId,roomId,joinCode},clock,auth){
 fixture(db);checkArgs(ownerHash,sessionHash,deviceId);const hash=secretHash(joinCode);if(!UUID.test(roomId)||!hash)deny();
 return transaction(db,()=>{
  const row=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);
  if(!row||row.closed||row.owner_hash!==ownerHash||!equalHash(row.ticket_hash,hash)||row.camera_session===sessionHash||row.camera_device===deviceId||!authorize(auth,ownerHash,sessionHash))return null;
  const now=clockNow(clock);if(!fresh(row,now,JOIN_TTL))return failed(db,row);
  if(!current(db,row,clock,auth))return null;
  if(row.prompter_session!==null)return row.prompter_session===sessionHash&&row.prompter_device===deviceId?{roomId,role:'prompter',created:false}:null;
  db.prepare('UPDATE studio_signal_rooms SET prompter_session=?,prompter_device=? WHERE room_id=? AND prompter_session IS NULL AND closed=0').run(sessionHash,deviceId,roomId);
  const joined=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);
  if(!bound(joined,ownerHash,sessionHash,'prompter',deviceId)||!current(db,joined,clock,auth))return null;
  return {roomId,role:'prompter',created:true};
 });
}
function member(db,owner,session,device,roomId,role,clock,auth){checkArgs(owner,session,device);if(!UUID.test(roomId))return null;const row=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);if(!bound(row,owner,session,role,device))return null;return current(db,row,clock,auth);}
export function approveStudioRoomFixture(db,{ownerHash,sessionHash,deviceId,roomId,role},clock,auth){
 fixture(db);return transaction(db,()=>{const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row||!row.prompter_session)return null;db.prepare(`UPDATE studio_signal_rooms SET ${role}_approved=1 WHERE room_id=?`).run(roomId);const updated=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);if(!current(db,updated,clock,auth))return null;return {ready:!!(updated.camera_approved&&updated.prompter_approved)};});
}
/** Both sides receive the same derived 128-bit HMAC pairing key only after explicit approval. */
export function studioPairingKeyFixture(db,{ownerHash,sessionHash,deviceId,roomId,role},serverSecret,clock,auth){
 fixture(db);if(!Buffer.isBuffer(serverSecret)||serverSecret.length<32)deny();
 return transaction(db,()=>{const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row||!row.camera_approved||!row.prompter_approved)return null;
  if(!equalHash(row.secret_epoch,createHmac('sha256',serverSecret).update('studio-signaling-epoch/v1').digest('hex')))return null;
  const token=createHmac('sha256',serverSecret).update('studio-signaling-key/v1\0').update([row.room_id,row.owner_hash,row.camera_session,row.camera_device,row.prompter_session,row.prompter_device].join('\0')).digest('hex').slice(0,32);
  if(!current(db,row,clock,auth))return null;return {token};});
}


/** One bounded directional byte frame. Lost ACK retries must be byte-identical. */
export function sendStudioFrameFixture(db,{ownerHash,sessionHash,deviceId,roomId,role,sequence,data},clock,auth){
 fixture(db);if(!Number.isSafeInteger(sequence)||sequence<1||!Buffer.isBuffer(data)||data.length<1||data.length>MAX_CHUNK)deny();
 return transaction(db,()=>{
  const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row||!row.camera_approved||!row.prompter_approved)return null;
  const next=row[role+'_next'],hash=sha(data);if(sequence===next-1&&row[role+'_last_hash']===hash)return {sequence,created:false};
  if(sequence!==next||next>=Number.MAX_SAFE_INTEGER||row[role+'_total']+data.length>MAX_TOTAL)return null;
  const q=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(length(data)),0) bytes FROM studio_signal_messages WHERE room_id=?').get(roomId);
  if(q.n>=MAX_MESSAGES||q.bytes+data.length>MAX_QUEUED)throw Error('STUDIO_RENDEZVOUS_BACKPRESSURE');
  db.prepare('INSERT INTO studio_signal_messages VALUES(?,?,?,?)').run(roomId,role,sequence,data);
  db.prepare(`UPDATE studio_signal_rooms SET ${role}_next=?,${role}_last_hash=?,${role}_total=? WHERE room_id=?`).run(next+1,hash,row[role+'_total']+data.length,roomId);
  const updated=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);if(!current(db,updated,clock,auth))return null;return {sequence,created:true};
 });
}
export function peekStudioFrameFixture(db,{ownerHash,sessionHash,deviceId,roomId,role},clock,auth){
 fixture(db);return transaction(db,()=>{const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row||!row.camera_approved||!row.prompter_approved)return null;
  const source=role==='camera'?'prompter':'camera',message=db.prepare('SELECT sequence,data FROM studio_signal_messages WHERE room_id=? AND source=? ORDER BY sequence LIMIT 1').get(roomId,source);
  if(!current(db,row,clock,auth))return null;return message?{sequence:message.sequence,data:Buffer.from(message.data)}:{empty:true};});
}
export function acknowledgeStudioFrameFixture(db,{ownerHash,sessionHash,deviceId,roomId,role,sequence},clock,auth){
 fixture(db);if(!Number.isSafeInteger(sequence)||sequence<1)deny();return transaction(db,()=>{const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row||!row.camera_approved||!row.prompter_approved)return null;
  const source=role==='camera'?'prompter':'camera',acked=row[source+'_acked'];if(sequence===acked)return {sequence,created:false};
  const first=db.prepare('SELECT sequence FROM studio_signal_messages WHERE room_id=? AND source=? ORDER BY sequence LIMIT 1').get(roomId,source);if(!first||first.sequence!==sequence||sequence!==acked+1)return null;
  db.prepare('DELETE FROM studio_signal_messages WHERE room_id=? AND source=? AND sequence=?').run(roomId,source,sequence);db.prepare(`UPDATE studio_signal_rooms SET ${source}_acked=? WHERE room_id=?`).run(sequence,roomId);
  const updated=db.prepare('SELECT * FROM studio_signal_rooms WHERE room_id=?').get(roomId);if(!current(db,updated,clock,auth))return null;return {sequence,created:true};});
}
export function closeStudioRoomFixture(db,{ownerHash,sessionHash,deviceId,roomId,role},clock,auth){
 fixture(db);return transaction(db,()=>{const row=member(db,ownerHash,sessionHash,deviceId,roomId,role,clock,auth);if(!row)return null;failed(db,row);return {closed:true};});
}
