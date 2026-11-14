import {createHash,randomBytes} from 'node:crypto';

// Isolated, test-only contract. No route or production migration.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,TICKET_MS=60_000,COMMAND_MS=10_000,STATE_MS=3_000,MAX_TICKETS=128,MAX_COMMANDS=1024;
const phases=new Set(['idle','ready','partial','failed','preparing','recording','paused','finalizing']);
const fail=()=>{throw Error('PAIRED_WEB_DENIED');};
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(db){if(process.env.NODE_ENV!=='test'||process.env.PAIRED_WEB_CAMERA_FIXTURE!=='1')throw Error('PAIRED_WEB_FIXTURE_DISABLED');if(!db||typeof db.transaction!=='function'||db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('INVALID_DB');}
function now(clock){const c=clock();if(!c||!UUID.test(c.runtimeId)||!Number.isSafeInteger(c.wall)||!Number.isSafeInteger(c.tick)||c.wall<0||c.tick<0)fail();return c;}
function fresh(row,c,ttl,prefix='created'){return row.runtime_id===c.runtimeId&&c.wall>=row[prefix+'_wall']&&c.tick>=row[prefix+'_tick']&&c.wall-row[prefix+'_wall']<ttl&&c.tick-row[prefix+'_tick']<ttl;}
function tx(db,fn,onDenied=()=>{}){
 const result=db.transaction(()=>{
  db.exec('SAVEPOINT pwc_action');
  try{const value=fn();if(value===null){db.exec('ROLLBACK TO pwc_action');db.exec('RELEASE pwc_action');onDenied();return null;}db.exec('RELEASE pwc_action');return value;}
  catch(error){db.exec('ROLLBACK TO pwc_action');db.exec('RELEASE pwc_action');throw error;}
 }).immediate();if(result===null)fail();return result;
}
const invalidateTicket=(db,context)=>{if(context.hash)db.prepare('UPDATE pwc_tickets SET revoked=1 WHERE token_hash=?').run(context.hash);};
function hashToken(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const bytes=Buffer.from(token,'base64url');return bytes.length===32&&bytes.toString('base64url')===token?sha(bytes):null;}
function fixedIdentity(i){return i&&Object.freeze({owner:i.owner,session:i.session,deviceId:i.deviceId,cameraId:i.cameraId,pairEpoch:i.pairEpoch});}
function fixedState(s){return s&&Object.freeze({revision:s.revision,phase:s.phase,recordingId:s.recordingId,projectId:s.projectId,front:s.front,confirmedCommandId:s.confirmedCommandId});}
function fixedCommand(c){return c&&Object.freeze({id:c.id,action:c.action,recordingId:c.recordingId,projectId:c.projectId,expectedFront:c.expectedFront,expectedRevision:c.expectedRevision});}
function validIdentity(i){return i&&HASH.test(i.owner)&&HASH.test(i.session)&&UUID.test(i.deviceId)&&UUID.test(i.cameraId)&&UUID.test(i.pairEpoch);}
function bound(row,i){return row&&validIdentity(i)&&row.owner===i.owner&&row.session===i.session&&row.device_id===i.deviceId&&row.camera_id===i.cameraId&&row.pair_epoch===i.pairEpoch&&row.revoked===0;}
function auth(callback,identity,kind){try{return typeof callback==='function'&&callback(Object.freeze({...identity}),kind)===true;}catch{return false;}}
function checkedTicket(db,identity,token,clock,authorize,context){
 const hash=hashToken(token),row=hash&&db.prepare('SELECT * FROM pwc_tickets WHERE token_hash=?').get(hash);if(!bound(row,identity))return null;
 let c=now(clock);if(row.runtime_id!==c.runtimeId)return null;if(!fresh(row,c,TICKET_MS)){context.hash=hash;return null;}
 if(!auth(authorize,identity,'device')){context.hash=hash;return null;}
 c=now(clock);if(!fresh(row,c,TICKET_MS)){if(row.runtime_id===c.runtimeId)context.hash=hash;return null;}
 const last=db.prepare('SELECT * FROM pwc_tickets WHERE token_hash=?').get(hash);
 if(!bound(last,identity)||last.runtime_id!==row.runtime_id||last.created_wall!==row.created_wall||last.created_tick!==row.created_tick)return null;
 return last;
}
function stateValid(s){return s&&Number.isSafeInteger(s.revision)&&s.revision>=1&&phases.has(s.phase)&&(s.recordingId===null||UUID.test(s.recordingId))&&(s.projectId===null||UUID.test(s.projectId))&&(s.front===null||typeof s.front==='boolean')&&(s.confirmedCommandId===null||UUID.test(s.confirmedCommandId))&&(!['preparing','recording','paused','finalizing'].includes(s.phase)||s.recordingId!==null);}
function commandValid(c){return c&&UUID.test(c.id)&&['start','pause','resume','stop','switch'].includes(c.action)&&UUID.test(c.recordingId)&&Number.isSafeInteger(c.expectedRevision)&&c.expectedRevision>=1&&(c.projectId===null||UUID.test(c.projectId))&&(c.expectedFront===null||typeof c.expectedFront==='boolean')&&((c.action==='start')===(c.projectId!==null))&&((c.action==='switch')===(c.expectedFront!==null))&&(c.action!=='switch'||c.recordingId===c.id);}
function permitted(c,s){
 if(c.expectedRevision!==s.revision)return false;
 if(c.action==='start')return ['idle','ready','partial','failed'].includes(s.phase)&&c.recordingId!==s.recordingId;
 if(c.action==='switch')return ['idle','ready','partial','failed'].includes(s.phase)&&s.front!==null&&c.expectedFront===s.front;
 return c.recordingId===s.recordingId&&((c.action==='pause'&&s.phase==='recording')||(c.action==='resume'&&s.phase==='paused')||(c.action==='stop'&&['preparing','recording','paused'].includes(s.phase)));
}
function confirmed(command,state){if(state.revision<=command.expected_revision)return false;
 switch(command.action){case 'start':return state.recording_id===command.recording_id&&['recording','paused'].includes(state.phase)&&state.project_id===command.project_id;case 'pause':return state.recording_id===command.recording_id&&state.phase==='paused';case 'resume':return state.recording_id===command.recording_id&&state.phase==='recording';case 'stop':return state.recording_id===command.recording_id&&['ready','partial','failed'].includes(state.phase);case 'switch':return state.front!==null&&state.front!==command.expected_front&&!['preparing','recording','paused','finalizing'].includes(state.phase);default:return false;}}
const sameCommand=(a,b)=>!!a&&!!b&&['id','token_hash','browser_session','payload_hash','action','recording_id','project_id','expected_front','expected_revision','runtime_id','created_wall','created_tick','result_phase','result_revision'].every(k=>a[k]===b[k]);
const sameState=(a,b)=>!!a&&!!b&&['token_hash','revision','phase','recording_id','project_id','front','runtime_id','created_wall','created_tick'].every(k=>a[k]===b[k]);
const stateObject=r=>({revision:r.revision,phase:r.phase,recordingId:r.recording_id,projectId:r.project_id,front:r.front===null?null:!!r.front});
export function initializePairedWebFixture(db){fixture(db);db.exec(`
 CREATE TABLE IF NOT EXISTS pwc_tickets(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,session TEXT NOT NULL,device_id TEXT NOT NULL,camera_id TEXT NOT NULL,pair_epoch TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS pwc_states(token_hash TEXT PRIMARY KEY,revision INTEGER NOT NULL,phase TEXT NOT NULL,recording_id TEXT,project_id TEXT,front INTEGER,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,FOREIGN KEY(token_hash) REFERENCES pwc_tickets(token_hash));
 CREATE TABLE IF NOT EXISTS pwc_commands(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,browser_session TEXT NOT NULL,payload_hash TEXT NOT NULL,action TEXT NOT NULL,recording_id TEXT NOT NULL,project_id TEXT,expected_front INTEGER,expected_revision INTEGER NOT NULL,stage TEXT NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,result_phase TEXT,result_revision INTEGER,FOREIGN KEY(token_hash) REFERENCES pwc_tickets(token_hash));
`);}
/** Authorizer MUST prove the real session/device and active, explicitly approved LAN pairing. */
export function issuePairedWebTicketFixture(db,identity,clock,authorize){
 fixture(db);identity=fixedIdentity(identity);if(!validIdentity(identity))fail();
 return tx(db,()=>{const c=now(clock);if(!auth(authorize,identity,'device'))return null;if(db.prepare('SELECT count(*) n FROM pwc_tickets').get().n>=MAX_TICKETS)return null;
  // Cross-ticket and cross-epoch camera fence. Old ambiguous executions must be reconciled first.
  const previous=db.prepare('SELECT * FROM pwc_tickets WHERE camera_id=?').all(identity.cameraId);
  for(const old of previous){
   if(old.runtime_id!==c.runtimeId)return null;
   if(!old.revoked&&fresh(old,c,TICKET_MS))return null;
   const active=db.prepare("SELECT * FROM pwc_commands WHERE token_hash=? AND stage IN ('queued','delivered','admitted','uncertain')").all(old.token_hash);
   for(const command of active){if(command.runtime_id!==c.runtimeId)return null;if(command.stage==='queued'&&!fresh(command,c,COMMAND_MS))db.prepare("UPDATE pwc_commands SET stage='expired' WHERE id=?").run(command.id);else return null;}
   if(!old.revoked)db.prepare('UPDATE pwc_tickets SET revoked=1 WHERE token_hash=?').run(old.token_hash);
  }
  const token=randomBytes(32).toString('base64url'),hash=hashToken(token);
  db.prepare('INSERT INTO pwc_tickets VALUES(?,?,?,?,?,?,?,?,?,0)').run(hash,identity.owner,identity.session,identity.deviceId,identity.cameraId,identity.pairEpoch,c.runtimeId,c.wall,c.tick);
  const row=db.prepare('SELECT * FROM pwc_tickets WHERE token_hash=?').get(hash),final=now(clock);if(!bound(row,identity)||!fresh(row,final,TICKET_MS)||!auth(authorize,identity,'device'))return null;
  const last=db.prepare('SELECT * FROM pwc_tickets WHERE token_hash=?').get(hash),end=now(clock);if(!bound(last,identity)||last.runtime_id!==c.runtimeId||last.created_wall!==c.wall||last.created_tick!==c.tick||!fresh(last,end,TICKET_MS))return null;
  return {ticket:token,expiresInMs:Math.min(TICKET_MS-(end.wall-c.wall),TICKET_MS-(end.tick-c.tick))};});
}
/** Caller must only report camera snapshots received on the exact approved LAN generation. */
export function reportPairedCameraFixture(db,identity,token,state,clock,authorize){
 fixture(db);identity=fixedIdentity(identity);state=fixedState(state);if(!stateValid(state))fail();const context={};return tx(db,()=>{
  const ticket=checkedTicket(db,identity,token,clock,authorize,context);if(!ticket)return null;const old=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash);if(old&&state.revision<=old.revision)return null;
  const c=now(clock);db.prepare('INSERT INTO pwc_states VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET revision=excluded.revision,phase=excluded.phase,recording_id=excluded.recording_id,project_id=excluded.project_id,front=excluded.front,runtime_id=excluded.runtime_id,created_wall=excluded.created_wall,created_tick=excluded.created_tick').run(ticket.token_hash,state.revision,state.phase,state.recordingId,state.projectId,state.front===null?null:Number(state.front),c.runtimeId,c.wall,c.tick);
  if(!checkedTicket(db,identity,token,clock,authorize,context))return null;
  const persisted=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash);if(!persisted||persisted.revision!==state.revision||persisted.phase!==state.phase||persisted.recording_id!==state.recordingId||persisted.project_id!==state.projectId||persisted.front!==(state.front===null?null:Number(state.front))||persisted.runtime_id!==c.runtimeId||persisted.created_wall!==c.wall||persisted.created_tick!==c.tick)return null;
  const pending=db.prepare("SELECT * FROM pwc_commands WHERE token_hash=? AND stage='admitted'").get(ticket.token_hash);
  if(pending){const end=now(clock);if(pending.runtime_id!==end.runtimeId)return null;
   if(!fresh(pending,end,COMMAND_MS))db.prepare("UPDATE pwc_commands SET stage='uncertain' WHERE id=? AND stage='admitted'").run(pending.id);
   else if(state.confirmedCommandId===pending.id&&confirmed(pending,persisted)){const stage=pending.action==='stop'&&state.phase==='partial'?'partial':pending.action==='stop'&&state.phase==='failed'?'failed':'confirmed';db.prepare("UPDATE pwc_commands SET stage=?,result_phase=?,result_revision=? WHERE id=? AND stage='admitted'").run(stage,state.phase,state.revision,pending.id);}}
  return {revision:state.revision};},()=>invalidateTicket(db,context));
}
/** Browser session is checked separately; it must have authority over the same owner. */
export function queuePairedWebCommandFixture(db,identity,token,browserSession,command,clock,authorize,projectExists){
 fixture(db);identity=fixedIdentity(identity);command=fixedCommand(command);if(!commandValid(command)||!HASH.test(browserSession)||typeof projectExists!=='function')fail();
 const payloadHash=sha(Buffer.from(JSON.stringify([command.id,command.action,command.recordingId,command.projectId,command.expectedFront,command.expectedRevision]))),context={};
 return tx(db,()=>{
  const ticket=checkedTicket(db,identity,token,clock,authorize,context);if(!ticket||!auth(authorize,{...identity,session:browserSession},'browser'))return null;
  const existing=db.prepare('SELECT * FROM pwc_commands WHERE id=?').get(command.id);
  if(existing){if(existing.token_hash!==ticket.token_hash||existing.browser_session!==browserSession||existing.payload_hash!==payloadHash)return null;
   const c=now(clock);if(existing.runtime_id!==c.runtimeId)return null;let stage=existing.stage;
   if(['queued','delivered','admitted','uncertain'].includes(stage)&&!fresh(existing,c,COMMAND_MS)){stage=stage==='queued'?'expired':'uncertain';db.prepare('UPDATE pwc_commands SET stage=? WHERE id=?').run(stage,existing.id);}
   if(!checkedTicket(db,identity,token,clock,authorize,context)||!auth(authorize,{...identity,session:browserSession},'browser'))return null;
   const last=db.prepare('SELECT * FROM pwc_commands WHERE id=?').get(existing.id);if(!sameCommand(existing,last)||last.stage!==stage)return null;
   return {id:existing.id,stage,created:false,resultPhase:last.result_phase,resultRevision:last.result_revision};}
  const c=now(clock),state=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash);if(!state||!fresh(state,c,STATE_MS)||!permitted(command,stateObject(state)))return null;
  if(command.action==='start'&&projectExists(command.projectId)!==true)return null;
  if(db.prepare("SELECT 1 FROM pwc_commands WHERE token_hash=? AND stage IN ('queued','delivered','admitted','uncertain')").get(ticket.token_hash)||db.prepare('SELECT count(*) n FROM pwc_commands').get().n>=MAX_COMMANDS)return null;
  db.prepare('INSERT INTO pwc_commands(id,token_hash,browser_session,payload_hash,action,recording_id,project_id,expected_front,expected_revision,stage,runtime_id,created_wall,created_tick) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(command.id,ticket.token_hash,browserSession,payloadHash,command.action,command.recordingId,command.projectId,command.expectedFront===null?null:Number(command.expectedFront),command.expectedRevision,'queued',c.runtimeId,c.wall,c.tick);
  if(command.action==='start'&&projectExists(command.projectId)!==true)return null;
  if(!checkedTicket(db,identity,token,clock,authorize,context)||!auth(authorize,{...identity,session:browserSession},'browser'))return null;
  const end=now(clock),last=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash),saved=db.prepare('SELECT * FROM pwc_commands WHERE id=?').get(command.id);if(!sameState(state,last)||!fresh(last,end,STATE_MS)||!fresh({runtime_id:c.runtimeId,created_wall:c.wall,created_tick:c.tick},end,COMMAND_MS)||!saved||saved.token_hash!==ticket.token_hash||saved.browser_session!==browserSession||saved.payload_hash!==payloadHash||saved.result_phase!==null||saved.result_revision!==null||saved.stage!=='queued'||saved.action!==command.action||saved.recording_id!==command.recordingId||saved.project_id!==command.projectId||saved.expected_revision!==command.expectedRevision||saved.expected_front!==(command.expectedFront===null?null:Number(command.expectedFront)))return null;
  return {id:command.id,stage:'queued',created:true};},()=>invalidateTicket(db,context));
}
/** Offers at most once. Unknown response or device crash must never trigger a replay. */
export function pollPairedWebCommandFixture(db,identity,token,clock,authorize,projectExists){
 fixture(db);identity=fixedIdentity(identity);if(typeof projectExists!=='function')fail();const context={};return tx(db,()=>{
  const ticket=checkedTicket(db,identity,token,clock,authorize,context);if(!ticket)return null;
  const c=now(clock),pending=db.prepare("SELECT * FROM pwc_commands WHERE token_hash=? AND stage IN ('queued','delivered','admitted','uncertain')").get(ticket.token_hash);if(!pending)return {empty:true};
  if(pending.runtime_id!==c.runtimeId)return null;
  if(!auth(authorize,{...identity,session:pending.browser_session},'browser')){const stage=pending.stage==='queued'?'cancelled':'uncertain';db.prepare('UPDATE pwc_commands SET stage=? WHERE id=?').run(stage,pending.id);return {empty:true,stage};}
  if(!fresh(pending,c,COMMAND_MS)){const stage=pending.stage==='queued'?'expired':'uncertain';db.prepare('UPDATE pwc_commands SET stage=? WHERE id=?').run(stage,pending.id);return {empty:true,stage};}
  if(pending.stage!=='queued')return {empty:true,stage:pending.stage};
  if(pending.action==='start'&&projectExists(pending.project_id)!==true){db.prepare("UPDATE pwc_commands SET stage='superseded' WHERE id=?").run(pending.id);return {empty:true,stage:'superseded'};}
  const snapshot=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash);const command={id:pending.id,action:pending.action,recordingId:pending.recording_id,projectId:pending.project_id,expectedFront:pending.expected_front===null?null:!!pending.expected_front,expectedRevision:pending.expected_revision};
  if(!snapshot||!fresh(snapshot,c,STATE_MS)||!permitted(command,stateObject(snapshot))){db.prepare("UPDATE pwc_commands SET stage='superseded' WHERE id=?").run(pending.id);return {empty:true,stage:'superseded'};}
  db.prepare("UPDATE pwc_commands SET stage='delivered' WHERE id=? AND stage='queued'").run(pending.id);
  if(pending.action==='start'&&projectExists(pending.project_id)!==true)return null;
  if(!checkedTicket(db,identity,token,clock,authorize,context)||!auth(authorize,{...identity,session:pending.browser_session},'browser'))return null;
  const latest=db.prepare('SELECT * FROM pwc_states WHERE token_hash=?').get(ticket.token_hash),end=now(clock);const delivered=db.prepare('SELECT * FROM pwc_commands WHERE id=?').get(pending.id);if(!sameCommand(pending,delivered)||delivered.stage!=='delivered'||!sameState(snapshot,latest)||!fresh(latest,end,STATE_MS)||!fresh(pending,end,COMMAND_MS)||!permitted(command,stateObject(latest)))return null;
  return {id:pending.id,action:pending.action,recordingId:pending.recording_id,projectId:pending.project_id,expectedFront:pending.expected_front===null?null:!!pending.expected_front,expectedRevision:pending.expected_revision};},()=>invalidateTicket(db,context));
}
/** Camera admission is not completion; only a newer camera-reported state can confirm it. */
export function acknowledgePairedWebCommandFixture(db,identity,token,id,accepted,clock,authorize){
 fixture(db);identity=fixedIdentity(identity);if(!UUID.test(id)||typeof accepted!=='boolean')fail();const context={};return tx(db,()=>{
  const ticket=checkedTicket(db,identity,token,clock,authorize,context);if(!ticket)return null;const cmd=db.prepare('SELECT * FROM pwc_commands WHERE id=? AND token_hash=?').get(id,ticket.token_hash);if(!cmd||cmd.stage!=='delivered')return null;
  const c=now(clock);if(!fresh(cmd,c,COMMAND_MS)){db.prepare("UPDATE pwc_commands SET stage='uncertain' WHERE id=?").run(id);return {stage:'uncertain'};}
  let stage=accepted?'admitted':'rejected';db.prepare('UPDATE pwc_commands SET stage=? WHERE id=?').run(stage,id);if(!checkedTicket(db,identity,token,clock,authorize,context))return null;const end=now(clock),last=db.prepare('SELECT * FROM pwc_commands WHERE id=?').get(id);if(!sameCommand(cmd,last)||last.stage!==stage||cmd.runtime_id!==end.runtimeId)return null;
  if(!fresh(cmd,end,COMMAND_MS)){stage='uncertain';db.prepare("UPDATE pwc_commands SET stage='uncertain' WHERE id=?").run(id);}return {stage};},()=>invalidateTicket(db,context));
}
