import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';

// Isolated test-only prototype: no route, no production migration and no account login.
const ORIGIN='https://videomaker.dorfspy.de',TTL=59_990,MAX_CHALLENGES=1024,MAX_PER_DEVICE=4,MAX_SESSIONS=1024,MAX_OPERATIONS=128;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
function fixture(db){
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE!=='1')fail('DEVICE_AUTH_FIXTURE_DISABLED');
 if(!db||typeof db.transaction!=='function'||db.inTransaction)fail('INVALID_DB');
 if(db.pragma('foreign_keys',{simple:true})!==1)fail('FOREIGN_KEYS_REQUIRED');
}
function validClock(c){return !!c&&UUID.test(c.runtimeId)&&Number.isSafeInteger(c.wall)&&c.wall>=0&&Number.isSafeInteger(c.tick)&&c.tick>=0;}
function clockNow(clock){const c=clock();if(!validClock(c))fail('INVALID_CLOCK');return c;}
function fresh(row,c){return row.runtime_id===c.runtimeId&&c.wall>=row.created_wall&&c.tick>=row.created_tick&&c.wall-row.created_wall<TTL&&c.tick-row.created_tick<TTL;}
function lp(...fields){
 const result=[];for(const field of fields){if(typeof field!=='string')fail('INVALID');const bytes=Buffer.from(field,'utf8');if(bytes.length>1024)fail('INVALID');const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);result.push(length,bytes);}return Buffer.concat(result);
}
const sha=data=>createHash('sha256').update(data).digest('hex');
function keyOf(value){
 try{const k=createPublicKey({key:value,format:'der',type:'spki'});if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(k.export({format:'der',type:'spki'})).equals(value))fail('DENIED');return k;}catch{fail('DENIED');}
}
function signatureValid(publicKey,message,signature){
 if(!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)return false;
 try{return verify('sha256',message,{key:keyOf(publicKey),dsaEncoding:'der'},signature);}catch{return false;}
}
function validateIds(deviceId,pairId,clientChallenge){
 if(typeof deviceId!=='string'||!UUID.test(deviceId)||typeof pairId!=='string'||!UUID.test(pairId)||typeof clientChallenge!=='string'||!HEX.test(clientChallenge))fail('INVALID');
}
function readPair(db,pairId,deviceId){
 const row=db.prepare(`SELECT p.pair_id,p.owner_hash,p.camera_id,p.prompter_id,p.revoked_at AS pair_revoked,
  d.public_key AS device_key,d.revoked_at AS device_revoked,peer.device_id AS peer_id,peer.public_key AS peer_key,peer.revoked_at AS peer_revoked,
  r.revision FROM relay_pair_links p JOIN relay_pair_devices d ON d.device_id=? AND d.owner_hash=p.owner_hash
  JOIN relay_pair_devices peer ON peer.device_id=CASE WHEN p.camera_id=d.device_id THEN p.prompter_id ELSE p.camera_id END AND peer.owner_hash=p.owner_hash
  JOIN device_auth_pair_revisions r ON r.pair_id=p.pair_id AND r.owner_hash=p.owner_hash
  WHERE p.pair_id=? AND (p.camera_id=d.device_id OR p.prompter_id=d.device_id)`).get(deviceId,pairId);
 if(!row||row.camera_id===row.prompter_id||!HEX.test(row.owner_hash)||!UUID.test(row.peer_id)||!Number.isSafeInteger(row.revision)||row.revision<1||!Buffer.isBuffer(row.device_key)||!Buffer.isBuffer(row.peer_key))fail('DENIED');
 return {...row,role:row.camera_id===deviceId?'camera':'prompter',revoked:row.pair_revoked!==null||row.device_revoked!==null||row.peer_revoked!==null};
}
function samePair(a,b){return a.owner_hash===b.owner_hash&&a.role===b.role&&a.peer_id===b.peer_id&&a.device_key.equals(b.device_key)&&a.peer_key.equals(b.peer_key);}
function sameRow(a,b,fields){return !!a&&!!b&&fields.every(field=>a[field]===b[field]);}
const challengeFields=['attempt_id','owner_hash','device_id','pair_id','role','client_challenge','server_nonce','revision','runtime_id','created_wall','created_tick'];
const sessionFields=['token_hash','owner_hash','device_id','pair_id','role','revision','runtime_id','created_wall','created_tick'];
function sessionHash(token){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const value=Buffer.from(token,'base64url');if(value.length!==32||value.toString('base64url')!==token)return null;return sha(value);
}

/** Install only on an isolated test DB that already has the experimental pair registry. */
export function initializeDeviceAuthFixture(db){
 fixture(db);
 db.transaction(()=>{
  const tables=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('relay_pair_devices','relay_pair_links')").get();if(tables.n!==2)fail('MISSING_PAIR_REGISTRY');
  db.exec(`
   CREATE TABLE IF NOT EXISTS device_auth_pair_revisions(pair_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1));
   CREATE TABLE IF NOT EXISTS device_auth_challenges(attempt_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,device_id TEXT NOT NULL,pair_id TEXT NOT NULL,role TEXT NOT NULL,client_challenge TEXT NOT NULL,server_nonce TEXT NOT NULL,revision INTEGER NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL,UNIQUE(device_id,client_challenge));
   CREATE TABLE IF NOT EXISTS device_auth_sessions(token_hash TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,device_id TEXT NOT NULL,pair_id TEXT NOT NULL,role TEXT NOT NULL,revision INTEGER NOT NULL,runtime_id TEXT NOT NULL,created_wall INTEGER NOT NULL,created_tick INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS device_auth_operations(token_hash TEXT NOT NULL,operation_nonce TEXT NOT NULL,PRIMARY KEY(token_hash,operation_nonce),FOREIGN KEY(token_hash) REFERENCES device_auth_sessions(token_hash) ON DELETE CASCADE);
   CREATE TRIGGER IF NOT EXISTS device_auth_new_pair AFTER INSERT ON relay_pair_links BEGIN INSERT INTO device_auth_pair_revisions VALUES(NEW.pair_id,NEW.owner_hash,1); END;
   CREATE TRIGGER IF NOT EXISTS device_auth_revoke_pair AFTER UPDATE OF revoked_at ON relay_pair_links WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN UPDATE device_auth_pair_revisions SET revision=revision+1 WHERE pair_id=NEW.pair_id AND owner_hash=NEW.owner_hash; END;
  `);
  db.prepare('INSERT OR IGNORE INTO device_auth_pair_revisions SELECT pair_id,owner_hash,CASE WHEN revoked_at IS NULL THEN 1 ELSE 2 END FROM relay_pair_links').run();
 }).immediate();
}

export function reconnectTranscript({ownerHash,deviceId,pairId,role,attemptId,clientChallenge,serverNonce,serverRevision}){
 validateIds(deviceId,pairId,clientChallenge);
 if(!HEX.test(ownerHash)||!UUID.test(attemptId)||!HEX.test(serverNonce)||!['camera','prompter'].includes(role)||!Number.isSafeInteger(serverRevision)||serverRevision<1)fail('INVALID');
 return lp('videomaker-device-reconnect/v1',ORIGIN,'reconnect',ownerHash,deviceId,pairId,role,attemptId,clientChallenge,serverNonce,String(serverRevision));
}

/** Browser login is not needed here: the registered Keystore key is proved on completion. */
export function beginDeviceReconnect(db,{deviceId,pairId,clientChallenge},clock){
 fixture(db);validateIds(deviceId,pairId,clientChallenge);if(typeof clock!=='function')fail('INVALID');
 return db.transaction(()=>{
  const first=clockNow(clock),pair=readPair(db,pairId,deviceId);if(first.wall>Number.MAX_SAFE_INTEGER-TTL)fail('INVALID_CLOCK');
  db.prepare('DELETE FROM device_auth_challenges WHERE runtime_id=? AND (created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(first.runtimeId,first.wall,first.tick,first.wall-TTL,first.tick-TTL);
  if(db.prepare('SELECT 1 FROM device_auth_challenges WHERE device_id=? AND client_challenge=?').get(deviceId,clientChallenge))fail('REPLAY');
  if(db.prepare('SELECT count(*) AS n FROM device_auth_challenges').get().n>=MAX_CHALLENGES||db.prepare('SELECT count(*) AS n FROM device_auth_challenges WHERE owner_hash=?').get(pair.owner_hash).n>=128||db.prepare('SELECT count(*) AS n FROM device_auth_challenges WHERE device_id=?').get(deviceId).n>=MAX_PER_DEVICE)fail('CAPACITY');
  const attemptId=randomUUID(),serverNonce=randomBytes(32).toString('hex');
  db.prepare('INSERT INTO device_auth_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(attemptId,pair.owner_hash,deviceId,pairId,pair.role,clientChallenge,serverNonce,pair.revision,first.runtimeId,first.wall,first.tick);
  const final=clockNow(clock),current=readPair(db,pairId,deviceId);
  const saved=db.prepare('SELECT * FROM device_auth_challenges WHERE attempt_id=?').get(attemptId);
  if(!saved||saved.owner_hash!==pair.owner_hash||saved.device_id!==deviceId||saved.pair_id!==pairId||saved.role!==pair.role||saved.client_challenge!==clientChallenge||saved.server_nonce!==serverNonce||saved.revision!==pair.revision||saved.runtime_id!==first.runtimeId||saved.created_wall!==first.wall||saved.created_tick!==first.tick||!samePair(pair,current)||current.revision!==pair.revision||!fresh(saved,final))fail('STALE');
  return {attemptId,serverNonce,expiresAt:first.wall+TTL,ownerHash:pair.owner_hash,deviceId,pairId,role:pair.role,serverRevision:pair.revision};
 }).immediate();
}

/** Valid proof consumes exactly one challenge; an expired one is removed before returning error. */
export function completeDeviceReconnect(db,{attemptId,clientChallenge,signature},clock){
 fixture(db);if(typeof attemptId!=='string'||!UUID.test(attemptId)||typeof clientChallenge!=='string'||!HEX.test(clientChallenge)||typeof clock!=='function')fail('INVALID');
 const result=db.transaction(()=>{
  const row=db.prepare('SELECT * FROM device_auth_challenges WHERE attempt_id=? AND client_challenge=?').get(attemptId,clientChallenge);if(!row)return {error:'DENIED'};
  let now=clockNow(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_auth_challenges WHERE attempt_id=? AND client_challenge=?').run(attemptId,clientChallenge);return {error:'EXPIRED'};}
  const initial=readPair(db,row.pair_id,row.device_id);
  if(initial.owner_hash!==row.owner_hash||initial.role!==row.role)fail('DENIED');
  const message=reconnectTranscript({ownerHash:row.owner_hash,deviceId:row.device_id,pairId:row.pair_id,role:row.role,attemptId,clientChallenge,serverNonce:row.server_nonce,serverRevision:row.revision});
  if(!signatureValid(initial.device_key,message,signature))return {error:'DENIED'};
  now=clockNow(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_auth_challenges WHERE attempt_id=? AND client_challenge=?').run(attemptId,clientChallenge);return {error:'EXPIRED'};}
  if(!sameRow(row,db.prepare('SELECT * FROM device_auth_challenges WHERE attempt_id=?').get(attemptId),challengeFields))return {error:'DENIED'};
  let pair=readPair(db,row.pair_id,row.device_id);if(!samePair(initial,pair)||pair.revision<row.revision)fail('DENIED');
  db.prepare('DELETE FROM device_auth_challenges WHERE attempt_id=? AND client_challenge=?').run(attemptId,clientChallenge);
  let sessionCredential=null,tokenHash=null,createdSession=null;
  if(!pair.revoked){
   db.prepare('DELETE FROM device_auth_sessions WHERE runtime_id=? AND (created_wall>? OR created_tick>? OR created_wall<=? OR created_tick<=?)').run(now.runtimeId,now.wall,now.tick,now.wall-TTL,now.tick-TTL);
   if(db.prepare('SELECT count(*) AS n FROM device_auth_sessions').get().n>=MAX_SESSIONS)fail('CAPACITY');
   sessionCredential=randomBytes(32).toString('base64url');tokenHash=sessionHash(sessionCredential);
   db.prepare('INSERT INTO device_auth_sessions VALUES(?,?,?,?,?,?,?,?,?)').run(tokenHash,pair.owner_hash,row.device_id,row.pair_id,pair.role,pair.revision,now.runtimeId,now.wall,now.tick);
   createdSession=db.prepare('SELECT * FROM device_auth_sessions WHERE token_hash=?').get(tokenHash);
  }
  const final=clockNow(clock);if(!fresh(row,final)){if(tokenHash)db.prepare('DELETE FROM device_auth_sessions WHERE token_hash=?').run(tokenHash);return {error:'EXPIRED'};}
  if(db.prepare('SELECT 1 FROM device_auth_challenges WHERE attempt_id=?').get(attemptId)){if(tokenHash)db.prepare('DELETE FROM device_auth_sessions WHERE token_hash=?').run(tokenHash);return {error:'DENIED'};}
  const last=readPair(db,row.pair_id,row.device_id);if(!samePair(pair,last)||last.revision<pair.revision)fail('DENIED');pair=last;
  if(pair.revoked&&tokenHash){db.prepare('DELETE FROM device_auth_sessions WHERE token_hash=?').run(tokenHash);sessionCredential=null;}
  else if(tokenHash&&!sameRow(createdSession,db.prepare('SELECT * FROM device_auth_sessions WHERE token_hash=?').get(tokenHash),sessionFields))return {error:'DENIED'};
  const ttlMs=Math.min(TTL-(final.tick-row.created_tick),TTL-(final.wall-row.created_wall));
  return {clientChallenge,pairId:row.pair_id,peerDeviceId:pair.peer_id,peerSpkiSha256:sha(pair.peer_key),serverRevision:pair.revision,revoked:pair.revoked,ttlMs,sessionCredential};
 }).immediate();
 if(result.error)fail(result.error);return result;
}

export function deviceRequestTranscript({ownerHash,deviceId,pairId,role,sessionHash:hash,requestNonce,method,path,bodySha256}){
 if(!HEX.test(ownerHash)||!UUID.test(deviceId)||!UUID.test(pairId)||!['camera','prompter'].includes(role)||!HEX.test(hash)||!HEX.test(requestNonce)||!['GET','POST'].includes(method)||!['/api/turn/credentials','/api/relay/connect'].includes(path)||!HEX.test(bodySha256))fail('INVALID');
 return lp('videomaker-device-request/v1',ORIGIN,ownerHash,deviceId,pairId,role,hash,requestNonce,method,path,bodySha256);
}

/**
 * Test-only per-request key proof: token alone is never authorization.
 * The caller MUST derive `actual` from the real request, never from client JSON.
 */
export function authorizeDeviceRequest(db,{sessionCredential,requestNonce,signature},actual,clock){
 fixture(db);const hash=sessionHash(sessionCredential);if(!hash||typeof requestNonce!=='string'||!HEX.test(requestNonce)||typeof clock!=='function')fail('DENIED');
 if(!actual||typeof actual!=='object')fail('DENIED');
 const {method,path,bodySha256}=actual;
 const result=db.transaction(()=>{
  const row=db.prepare('SELECT * FROM device_auth_sessions WHERE token_hash=?').get(hash);if(!row)return {error:'DENIED'};
  let now=clockNow(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_auth_sessions WHERE token_hash=?').run(hash);return {error:'EXPIRED'};}
  let pair=readPair(db,row.pair_id,row.device_id);if(pair.revoked||pair.owner_hash!==row.owner_hash||pair.role!==row.role||pair.revision!==row.revision)return {error:'DENIED'};
  const message=deviceRequestTranscript({ownerHash:row.owner_hash,deviceId:row.device_id,pairId:row.pair_id,role:row.role,sessionHash:hash,requestNonce,method,path,bodySha256});
  if(!signatureValid(pair.device_key,message,signature))return {error:'DENIED'};
  if(db.prepare('SELECT count(*) AS n FROM device_auth_operations WHERE token_hash=?').get(hash).n>=MAX_OPERATIONS)return {error:'CAPACITY'};
  const inserted=db.prepare('INSERT OR IGNORE INTO device_auth_operations(token_hash,operation_nonce) VALUES(?,?)').run(hash,requestNonce);if(inserted.changes!==1)return {error:'REPLAY'};
  now=clockNow(clock);if(!fresh(row,now)){if(row.runtime_id===now.runtimeId)db.prepare('DELETE FROM device_auth_sessions WHERE token_hash=?').run(hash);return {error:'EXPIRED'};}
  if(!sameRow(row,db.prepare('SELECT * FROM device_auth_sessions WHERE token_hash=?').get(hash),sessionFields)||!db.prepare('SELECT 1 FROM device_auth_operations WHERE token_hash=? AND operation_nonce=?').get(hash,requestNonce))return {error:'DENIED'};
  const last=readPair(db,row.pair_id,row.device_id);if(!samePair(pair,last)||last.revoked||last.revision!==row.revision)return {error:'DENIED'};
  return {ownerHash:row.owner_hash,deviceId:row.device_id,pairId:row.pair_id,role:row.role,serverRevision:row.revision};
 }).immediate();
 if(result.error)fail(result.error);return result;
}
