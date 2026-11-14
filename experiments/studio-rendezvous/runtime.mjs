// Test-only single-host runtime admission; the caller must use the real Linux boot clock.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUARANTINE_MS=10_000,MAX_BATCH=128;
function fixture(db){if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE!=='1')throw Error('STUDIO_RENDEZVOUS_FIXTURE_DISABLED');if(!db||typeof db.transaction!=='function'||db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('INVALID_DB');}
function valid(c){return !!c&&UUID.test(c.runtimeId)&&Number.isSafeInteger(c.tick)&&c.tick>=0&&c.tick<=Number.MAX_SAFE_INTEGER-QUARANTINE_MS;}
function has(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
export function initializeStudioRuntimeSchemaFixture(db){fixture(db);db.exec('CREATE TABLE IF NOT EXISTS studio_signal_runtime(id INTEGER PRIMARY KEY CHECK(id=1),runtime_id TEXT NOT NULL,ready_tick INTEGER NOT NULL)');}
/** Called at worker startup only with a trusted same-host Linux boot clock. */
export function prepareStudioRuntimeFixture(db,clock){
 fixture(db);if(typeof clock!=='function')throw Error('INVALID_CLOCK');
 return db.transaction(()=>{
  const now=clock();if(!valid(now))throw Error('INVALID_CLOCK');let row=db.prepare('SELECT * FROM studio_signal_runtime WHERE id=1').get();
  if(!row){
   // Never silently adopt older unversioned state.
   for(const name of ['studio_signal_rooms','studio_signal_rates','studio_signal_attempts'])if(has(db,name)&&db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get())throw Error('UNKNOWN_RUNTIME_STATE');
   db.prepare('INSERT INTO studio_signal_runtime VALUES(1,?,0)').run(now.runtimeId);return {ready:true,transitioned:false,removedRooms:0,removedRates:0};
  }
  let transitioned=false;
  if(row.runtime_id!==now.runtimeId){
   // Old workers cannot survive an actual same-host kernel reboot. Hold off new access
   // for one full rate window; no multi-host/shared-db deployment is supported.
   db.prepare('UPDATE studio_signal_runtime SET runtime_id=?,ready_tick=? WHERE id=1').run(now.runtimeId,now.tick+QUARANTINE_MS);
   if(has(db,'studio_signal_rooms'))db.prepare('UPDATE studio_signal_rooms SET closed=1 WHERE runtime_id<>?').run(now.runtimeId);
   if(has(db,'studio_signal_messages')&&has(db,'studio_signal_rooms'))db.prepare('DELETE FROM studio_signal_messages WHERE room_id IN (SELECT room_id FROM studio_signal_rooms WHERE runtime_id<>?)').run(now.runtimeId);
   row={runtime_id:now.runtimeId,ready_tick:now.tick+QUARANTINE_MS};transitioned=true;
  }
  const last=clock();if(!valid(last)||last.runtimeId!==now.runtimeId||last.tick<now.tick)throw Error('INVALID_CLOCK');
  if(last.tick<row.ready_tick)return {ready:false,transitioned,removedRooms:0,removedRates:0};
  let removedRooms=0,removedRates=0;
  if(has(db,'studio_signal_rooms'))removedRooms=db.prepare('DELETE FROM studio_signal_rooms WHERE rowid IN (SELECT rowid FROM studio_signal_rooms WHERE closed=1 AND runtime_id<>? LIMIT ?)').run(now.runtimeId,MAX_BATCH).changes;
  if(has(db,'studio_signal_rates'))removedRates=db.prepare('DELETE FROM studio_signal_rates WHERE rowid IN (SELECT rowid FROM studio_signal_rates WHERE runtime_id<>? LIMIT ?)').run(now.runtimeId,MAX_BATCH).changes;
  return {ready:true,transitioned,removedRooms,removedRates};
 }).immediate();
}
/** Must be called under the same SQLite transaction as the guarded operation. */
export function studioRuntimeAdmissibleFixture(db,now){
 if(!db.inTransaction||!valid(now))return false;
 const row=db.prepare('SELECT runtime_id,ready_tick FROM studio_signal_runtime WHERE id=1').get();return !!row&&row.runtime_id===now.runtimeId&&now.tick>=row.ready_tick;
}

/** Reclaim only completed attempts bound to a durably revoked or expired browser session. */
export function cleanupStudioAttemptsFixture(db,clock,limit=32){
 fixture(db);if(typeof clock!=='function'||!Number.isSafeInteger(limit)||limit<1||limit>128)throw Error('INVALID_CLEANUP');
 return db.transaction(()=>{
  const now=clock();if(!studioRuntimeAdmissibleFixture(db,now))return 0;
  if(!['studio_signal_attempts','studio_signal_rooms','relay_browser_sessions','auth_session_revocations'].every(name=>has(db,name)))return 0;
  const rows=db.prepare(`SELECT a.rowid AS id FROM studio_signal_attempts a
   JOIN relay_browser_sessions s ON s.owner_hash=a.owner_hash AND s.session_hash=a.session_hash
   WHERE (s.expired=1 OR EXISTS(SELECT 1 FROM auth_session_revocations v WHERE v.session_hash=s.revocation_hash))
   AND NOT EXISTS(SELECT 1 FROM studio_signal_rooms r WHERE r.owner_hash=a.owner_hash AND r.camera_session=a.session_hash AND r.create_attempt=a.attempt_id AND r.closed=0)
   ORDER BY a.rowid LIMIT ?`).all(limit);
  const del=db.prepare('DELETE FROM studio_signal_attempts WHERE rowid=?');let removed=0;for(const row of rows)removed+=del.run(row.id).changes;
  return removed;
 }).immediate();
}
