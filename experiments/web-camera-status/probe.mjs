import {randomUUID} from 'node:crypto';

// Pure isolated fixture: callbacks stand in for the currently missing, transactional
// device/pair proof. No production route may call this implementation as-is.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const TTL=10000;
const deny=()=>{throw Error('STATUS_PROBE_DENIED');};
const valid=i=>i&&HASH.test(i.owner)&&HASH.test(i.browserSession)&&HASH.test(i.deviceSession)&&UUID.test(i.prompterId)&&UUID.test(i.cameraId)&&i.prompterId!==i.cameraId&&UUID.test(i.pairEpoch);
const copy=i=>Object.freeze({owner:i.owner,browserSession:i.browserSession,deviceSession:i.deviceSession,prompterId:i.prompterId,cameraId:i.cameraId,pairEpoch:i.pairEpoch});
function enabled(db){if(process.env.NODE_ENV!=='test'||process.env.WEB_CAMERA_STATUS_FIXTURE!=='1'||db.inTransaction)deny();}
function now(clock){const x=clock();if(!x||!UUID.test(x.boot)||![x.wall,x.tick].every(n=>Number.isSafeInteger(n)&&n>=0))deny();return x;}
function permitted(auth,i){try{return auth(copy(i),'browser')===true&&auth(copy(i),'device')===true&&auth(copy(i),'pair')===true;}catch{return false;}}
function fresh(row,c){return row.boot===c.boot&&c.wall>=row.wall&&c.tick>=row.tick&&c.wall-row.wall<TTL&&c.tick-row.tick<TTL;}
function same(row,i){return row&&row.owner===i.owner&&row.browser_session===i.browserSession&&row.device_session===i.deviceSession&&row.prompter_id===i.prompterId&&row.camera_id===i.cameraId&&row.pair_epoch===i.pairEpoch;}
const unchanged=(a,b)=>!!a&&!!b&&['id','owner','browser_session','device_session','prompter_id','camera_id','pair_epoch','boot','wall','tick','state','result'].every(k=>a[k]===b[k]);
const rowById=(db,id)=>db.prepare('SELECT * FROM web_camera_status_probe_fixture WHERE id=?').get(id);
function outcome(row){return {id:row.id,state:row.state,...(row.state==='complete'?{status:JSON.parse(row.result)}:{})};}
function run(db,action){const denied=Symbol('denied');try{return db.transaction(()=>{const result=action();if(result===null)throw denied;return result;}).immediate();}catch(error){if(error===denied)deny();throw error;}}
export function initStatusProbes(db){enabled(db);db.exec(`CREATE TABLE IF NOT EXISTS web_camera_status_probe_fixture(id TEXT PRIMARY KEY,owner TEXT NOT NULL,browser_session TEXT NOT NULL,device_session TEXT NOT NULL,prompter_id TEXT NOT NULL,camera_id TEXT NOT NULL,pair_epoch TEXT NOT NULL,boot TEXT NOT NULL,wall INTEGER NOT NULL,tick INTEGER NOT NULL,state TEXT NOT NULL,result TEXT)`);}
/** An opaque request ID identifies the result; it is not a device bearer token. */
export function beginStatusProbe(db,input,clock,auth){enabled(db);const i=copy(input);if(!valid(i))deny();return run(db,()=>{
 const t=now(clock);if(!permitted(auth,i))return null;
 if(db.prepare("SELECT 1 FROM web_camera_status_probe_fixture WHERE camera_id=? AND state IN ('queued','delivered')").get(i.cameraId))return null;
 if(db.prepare('SELECT count(*) n FROM web_camera_status_probe_fixture').get().n>=128)return null;
 const id=randomUUID();db.prepare('INSERT INTO web_camera_status_probe_fixture VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id,i.owner,i.browserSession,i.deviceSession,i.prompterId,i.cameraId,i.pairEpoch,t.boot,t.wall,t.tick,'queued');
 const row=rowById(db,id);if(!same(row,i)||!permitted(auth,i)||!fresh(row,now(clock))||!unchanged(row,rowById(db,id))||db.prepare("SELECT count(*) n FROM web_camera_status_probe_fixture WHERE camera_id=? AND state IN ('queued','delivered')").get(i.cameraId).n!==1)return null;
 return {id,state:'queued'};
});}
/** A device poll receives at most one query; a lost delivery stays uncertain. */
export function deliverStatusProbe(db,input,id,clock,auth){enabled(db);const i=copy(input);if(!valid(i)||!UUID.test(id))deny();return run(db,()=>{
 const row=db.prepare('SELECT * FROM web_camera_status_probe_fixture WHERE id=?').get(id),t=now(clock);
 if(!same(row,i)||row.boot!==t.boot||!permitted(auth,i)||!unchanged(row,rowById(db,id)))return null;
 if(!fresh(row,t)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=? AND state IN ('queued','delivered')").run(id);return {id,state:'expired'};}
 if(row.state==='delivered')return {id,state:'uncertain'};
 if(row.state!=='queued')return outcome(row);
 if(db.prepare("UPDATE web_camera_status_probe_fixture SET state='delivered' WHERE id=? AND state='queued'").run(id).changes!==1)return null;
 const delivered=rowById(db,id);
 if(!permitted(auth,i))return null;const end=now(clock);if(end.boot!==row.boot||!unchanged(delivered,rowById(db,id)))return null;
 if(!fresh(row,end)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=?").run(id);return {id,state:'expired'};}
 return {id,state:'delivered',pairEpoch:i.pairEpoch};
});}
/** The caller must prove this snapshot came from the approved camera channel. */
export function completeStatusProbe(db,input,id,status,clock,auth,cameraProof){enabled(db);const i=copy(input);if(!valid(i)||!UUID.test(id)||!status||!['idle','preparing','recording','paused','finalizing','ready','partial','failed'].includes(status.phase)||!(status.recordingId===null||UUID.test(status.recordingId))||(['preparing','recording','paused','finalizing'].includes(status.phase)&&status.recordingId===null)||!(status.front===null||typeof status.front==='boolean'))deny();
 const safe=Object.freeze({phase:status.phase,recordingId:status.recordingId,front:status.front});return run(db,()=>{
 const row=db.prepare('SELECT * FROM web_camera_status_probe_fixture WHERE id=?').get(id),t=now(clock);if(!same(row,i)||row.boot!==t.boot||!permitted(auth,i)||!unchanged(row,rowById(db,id)))return null;
 if(!fresh(row,t)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=? AND state IN ('queued','delivered')").run(id);return {id,state:'expired'};}
 if(row.state!=='delivered')return null;
 try{if(cameraProof(copy(i),id,safe)!==true)return null;}catch{return null;}
 if(!permitted(auth,i))return null;const end=now(clock);if(end.boot!==row.boot||!unchanged(row,rowById(db,id)))return null;
 if(!fresh(row,end)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired' WHERE id=?").run(id);return {id,state:'expired'};}
 if(db.prepare("UPDATE web_camera_status_probe_fixture SET state='complete',result=? WHERE id=? AND state='delivered'").run(JSON.stringify(safe),id).changes!==1)return null;
 return {id,state:'complete'};
});}
/** Browser lookup requires both original sessions and verified current pair. */
export function readStatusProbe(db,input,id,clock,auth){enabled(db);const i=copy(input);if(!valid(i)||!UUID.test(id))deny();return run(db,()=>{
 const row=db.prepare('SELECT * FROM web_camera_status_probe_fixture WHERE id=?').get(id);if(!same(row,i)||!permitted(auth,i))return null;
 const t=now(clock);if(row.boot!==t.boot||!unchanged(row,rowById(db,id)))return null;if(!fresh(row,t)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired',result=NULL WHERE id=?").run(id);return {id,state:'expired'};}
 if(!permitted(auth,i))return null;const end=now(clock);if(end.boot!==row.boot||!unchanged(row,rowById(db,id)))return null;
 if(!fresh(row,end)){db.prepare("UPDATE web_camera_status_probe_fixture SET state='expired',result=NULL WHERE id=?").run(id);return {id,state:'expired'};}
 return outcome(row);
});}
