// Explicitly synthetic fixture. It does not authenticate callers, devices or a pair.
// Browser/device session hashes are test labels, not validated credentials.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {verifyStatusProof} from './status-proof.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,HASH=/^[0-9a-f]{64}$/,TTL=10_000,MAX_REQUESTS=128;
const unknown=()=>({state:'unknown'});
const keyHash=key=>createHash('sha256').update(key).digest('hex');
function copyValues(value,names){try{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==names.slice().sort().join(','))return null;const out={};for(const name of names){const d=Object.getOwnPropertyDescriptor(value,name);if(!d||!('value' in d))return null;out[name]=d.value;}return Object.freeze(out);}catch{return null;}}
const copyContext=b=>copyValues(b,['owner','browserSession','deviceSession','cameraId','prompterId','pairEpoch']);
const copyStatus=s=>copyValues(s,['revision','phase','recordingId','projectKnown','projectId','front']);
function enabled(db){if(process.env.NODE_ENV!=='test'||process.env.WEB_STATUS_REGISTRY_FIXTURE!=='1'||db.inTransaction)throw Error('FIXTURE_DISABLED');}
function observe(db,clock){let n;try{n=clock();}catch{return null;}if(!Number.isSafeInteger(n)||n<0||n>Number.MAX_SAFE_INTEGER-TTL)return null;const floor=db.prepare('SELECT floor_ms FROM status_fixture_clock WHERE id=1').get().floor_ms;if(n<floor)return null;db.prepare('UPDATE status_fixture_clock SET floor_ms=? WHERE id=1').run(n);return n;}
function liveSessions(db,b){
 const browser=db.prepare("SELECT * FROM status_fixture_sessions WHERE session_hash=? AND kind='browser' AND revoked=0").get(b.browserSession);
 const device=db.prepare("SELECT * FROM status_fixture_sessions WHERE session_hash=? AND kind='device' AND revoked=0").get(b.deviceSession);
 if(!browser||!device||b.browserSession===b.deviceSession||browser.owner!==b.owner||device.owner!==b.owner||device.device_id!==b.prompterId)return false;
 return true;
}
function activePair(db,b){return db.prepare('SELECT p.* FROM status_fixture_pairs p WHERE p.owner=? AND p.prompter_id=? AND p.camera_id=? AND p.epoch=? AND p.revoked=0 AND p.connected=1 AND NOT EXISTS (SELECT 1 FROM status_fixture_pairs other WHERE other.camera_public_key=p.camera_public_key AND other.camera_id<>p.camera_id)').get(b.owner,b.prompterId,b.cameraId,b.pairEpoch);}
function validContext(b){return b&&[b.owner,b.browserSession,b.deviceSession].every(v=>typeof v==='string'&&HASH.test(v))&&[b.cameraId,b.prompterId,b.pairEpoch].every(v=>typeof v==='string'&&UUID.test(v))&&b.cameraId!==b.prompterId;}
const sameRequest=(a,b)=>!!a&&!!b&&['id','owner','browser_session','device_session','camera_id','prompter_id','epoch','nonce','created_ms','link_generation','state','result','key_hash'].every(k=>a[k]===b[k]);
function matches(r,b){return r&&r.owner===b.owner&&r.browser_session===b.browserSession&&r.device_session===b.deviceSession&&r.camera_id===b.cameraId&&r.prompter_id===b.prompterId&&r.epoch===b.pairEpoch;}
function fresh(r,n){return n!==null&&n>=r.created_ms&&n-r.created_ms<TTL;}
function contextFrom(r){return {owner:r.owner,browserSession:r.browser_session,deviceSession:r.device_session,cameraId:r.camera_id,prompterId:r.prompter_id,pairEpoch:r.epoch,requestId:r.id,nonce:r.nonce};}
export function initStatusRegistryFixture(db){enabled(db);db.exec(`
 CREATE TABLE IF NOT EXISTS status_fixture_clock(id INTEGER PRIMARY KEY CHECK(id=1), floor_ms INTEGER NOT NULL); INSERT OR IGNORE INTO status_fixture_clock VALUES(1,0);
 CREATE TABLE IF NOT EXISTS status_fixture_sessions(session_hash TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,device_id TEXT,revoked INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS status_fixture_pairs(owner TEXT NOT NULL,prompter_id TEXT NOT NULL,camera_id TEXT NOT NULL,epoch TEXT NOT NULL,camera_public_key BLOB NOT NULL,revoked INTEGER NOT NULL,connected INTEGER NOT NULL,link_generation INTEGER NOT NULL,PRIMARY KEY(camera_id,epoch));
 CREATE UNIQUE INDEX IF NOT EXISTS status_fixture_one_active_camera ON status_fixture_pairs(camera_id) WHERE revoked=0;
 CREATE TABLE IF NOT EXISTS status_fixture_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,browser_session TEXT NOT NULL,device_session TEXT NOT NULL,camera_id TEXT NOT NULL,prompter_id TEXT NOT NULL,epoch TEXT NOT NULL,nonce TEXT NOT NULL,created_ms INTEGER NOT NULL,link_generation INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,key_hash TEXT);
 `);}
/** Test labels and public keys must be seeded directly. No onboarding exists here. */
export function openStatusFixture(db,input,clock){enabled(db);const b=copyContext(input);if(!validContext(b))return unknown();return db.transaction(()=>{
 const now=observe(db,clock),pair=activePair(db,b);if(now===null||!liveSessions(db,b)||!pair||db.prepare('SELECT count(*) n FROM status_fixture_requests').get().n>=MAX_REQUESTS)return unknown();
 const requestId=randomUUID(),nonce=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO status_fixture_requests VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',NULL,NULL)').run(requestId,b.owner,b.browserSession,b.deviceSession,b.cameraId,b.prompterId,b.pairEpoch,nonce,now,pair.link_generation);
 const inserted=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId),end=observe(db,clock),last=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId),endPair=activePair(db,b);
 if(!fresh(inserted,end)||!sameRequest(inserted,last)||!liveSessions(db,b)||!endPair||inserted.link_generation!==endPair.link_generation||keyHash(endPair.camera_public_key)!==keyHash(pair.camera_public_key)){db.prepare('DELETE FROM status_fixture_requests WHERE id=?').run(requestId);return unknown();}
 return {state:'pending',requestId,nonce};
 }).immediate();}
/** The key is read from the bound pair row, never from the proof request. */
export function acceptStatusFixture(db,input,requestId,observation,signature,clock){enabled(db);const b=copyContext(input),safe=copyStatus(observation);if(!validContext(b)||!safe||typeof requestId!=='string'||!UUID.test(requestId))return unknown();return db.transaction(()=>{
 const now=observe(db,clock),r=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId),pair=activePair(db,b);
 if(!matches(r,b)||!fresh(r,now)||r.state!=='pending'||!liveSessions(db,b)||!pair||r.link_generation!==pair.link_generation)return unknown();
 if(!verifyStatusProof(contextFrom(r),safe,Buffer.from(pair.camera_public_key),signature))return unknown();
 const end=observe(db,clock),finalPair=activePair(db,b),current=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId);
 if(!fresh(r,end)||!sameRequest(r,current)||!liveSessions(db,b)||!finalPair||r.link_generation!==finalPair.link_generation||keyHash(finalPair.camera_public_key)!==keyHash(pair.camera_public_key))return unknown();
 // Serialize exactly the copied immutable values whose signature was verified.
 if(db.prepare("UPDATE status_fixture_requests SET state='complete',result=?,key_hash=? WHERE id=? AND state='pending'").run(JSON.stringify(safe),keyHash(pair.camera_public_key),requestId).changes!==1)return unknown();
 return {state:'complete'};
 }).immediate();}
/** No data is returned after revoked/changed pair, either session, expiration or clock rollback. */
export function readStatusFixture(db,input,requestId,clock){enabled(db);const b=copyContext(input);if(!validContext(b)||typeof requestId!=='string'||!UUID.test(requestId))return unknown();return db.transaction(()=>{
 const now=observe(db,clock),r=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId);
 const pair=activePair(db,b);
 if(!matches(r,b)||!fresh(r,now)||!liveSessions(db,b)||!pair||r.link_generation!==pair.link_generation||r.state!=='complete'||r.key_hash!==keyHash(pair.camera_public_key))return unknown();
 const end=observe(db,clock),current=db.prepare('SELECT * FROM status_fixture_requests WHERE id=?').get(requestId),endPair=activePair(db,b);
 if(!fresh(r,end)||!sameRequest(r,current)||!liveSessions(db,b)||!endPair||r.link_generation!==endPair.link_generation||r.key_hash!==keyHash(endPair.camera_public_key))return unknown();
 return {state:'known',status:JSON.parse(r.result)};
 }).immediate();}

/** Synthetic lifecycle injection; real pair proof and channel ownership are not implemented. */
export function transitionChannelFixture(db,cameraId,epoch,connected){enabled(db);if(typeof cameraId!=='string'||!UUID.test(cameraId)||typeof epoch!=='string'||!UUID.test(epoch)||typeof connected!=='boolean')return false;return db.transaction(()=>{
 const pair=db.prepare('SELECT * FROM status_fixture_pairs WHERE camera_id=? AND epoch=? AND revoked=0').get(cameraId,epoch);
 if(!pair||!Number.isSafeInteger(pair.link_generation)||pair.link_generation>=Number.MAX_SAFE_INTEGER)return false;
 return db.prepare('UPDATE status_fixture_pairs SET connected=?,link_generation=link_generation+1 WHERE camera_id=? AND epoch=? AND revoked=0').run(connected?1:0,cameraId,epoch).changes===1;
 }).immediate();}
