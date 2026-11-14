import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import Database from 'better-sqlite3';
import {ensureCameraPairingSchema,issuePairingChallenge,completePairing,verifyCameraDeviceTicket,parsePairingComplete,PAIRING_CHALLENGE_TTL_MS,PAIRING_TICKET_TTL_MS} from '../lib/camera-device-pairing.ts';
const owner='a'.repeat(64),otherOwner='b'.repeat(64),makeClock=()=>({runtimeId:randomUUID(),wall:1000000,tick:100000});
const b64=b=>b.toString('base64url');
const keypair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function setup(){const db=new Database(':memory:');ensureCameraPairingSchema(db);return db;}
function response(deviceId,action,challenge,key,payload){const digest=createHash('sha256').update(payload).digest('hex');const message=`videomaker-camera-device-auth/v2\n${deviceId}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${digest}\n`;return {deviceId,action,challengeId:challenge.challengeId,payload:b64(payload),signature:b64(sign('sha256',Buffer.from(message),key))};}
function register(db,deviceId,keys,clock){const challenge=issuePairingChallenge(db,{deviceId,action:'register'},owner,clock);const spki=keys.publicKey.export({format:'der',type:'spki'});const data=response(deviceId,'register',challenge,keys.privateKey,spki);assert.deepEqual(completePairing(db,data,owner,()=>clock),{registered:true});return data;}
test('real P-256 DER registration and owner-bound, hashed, expiring ticket',()=>{
 const db=setup(),clock=makeClock(),id=randomUUID(),keys=keypair();const registration=register(db,id,keys,clock);
 assert.throws(()=>completePairing(db,registration,owner,()=>clock));
 const challenge=issuePairingChallenge(db,{deviceId:id,action:'session'},owner,clock),proof=response(id,'session',challenge,keys.privateKey,Buffer.alloc(0));
 const result=completePairing(db,proof,owner,()=>clock);assert.equal(Buffer.from(result.ticket,'base64url').length,32);assert.equal(result.expiresInMs,PAIRING_TICKET_TTL_MS);
 assert.equal(verifyCameraDeviceTicket(db,id,result.ticket,owner,clock),true);
 assert.equal(verifyCameraDeviceTicket(db,id,result.ticket,otherOwner,clock),false);
 assert.equal(verifyCameraDeviceTicket(db,randomUUID(),result.ticket,owner,clock),false);
 assert.equal(verifyCameraDeviceTicket(db,id,result.ticket,owner,{...clock,runtimeId:randomUUID()}),false);
 assert.equal(verifyCameraDeviceTicket(db,id,result.ticket,owner,{...clock,wall:clock.wall-1}),false);
 assert.equal(verifyCameraDeviceTicket(db,id,result.ticket,owner,{...clock,tick:clock.tick+PAIRING_TICKET_TTL_MS}),false);
 assert.equal(db.prepare('SELECT ticket_hash FROM camera_device_tickets').get().ticket_hash,createHash('sha256').update(result.ticket).digest('hex'));
 assert.throws(()=>completePairing(db,proof,owner,()=>clock));db.close();
});
test('wrong signatures, payload, owner and action cannot redeem challenge',()=>{
 const db=setup(),clock=makeClock(),id=randomUUID(),keys=keypair(),wrong=keypair(),challenge=issuePairingChallenge(db,{deviceId:id,action:'register'},owner,clock);
 const spki=keys.publicKey.export({format:'der',type:'spki'}),proof=response(id,'register',challenge,keys.privateKey,spki);
 assert.throws(()=>completePairing(db,response(id,'register',challenge,wrong.privateKey,spki),owner,()=>clock));
 assert.throws(()=>completePairing(db,{...proof,payload:b64(wrong.publicKey.export({format:'der',type:'spki'}))},owner,()=>clock));
 assert.throws(()=>completePairing(db,proof,otherOwner,()=>clock));
 assert.throws(()=>completePairing(db,{...proof,action:'session'},owner,()=>clock));
 assert.deepEqual(completePairing(db,proof,owner,()=>clock),{registered:true});db.close();
});
test('replaced, expired, restarted, clock-regressed or delayed challenges fail closed',()=>{
 const db=setup(),clock=makeClock(),id=randomUUID(),keys=keypair(),spki=keys.publicKey.export({format:'der',type:'spki'});
 const old=issuePairingChallenge(db,{deviceId:id,action:'register'},owner,clock),latest=issuePairingChallenge(db,{deviceId:id,action:'register'},owner,clock);
 assert.throws(()=>completePairing(db,response(id,'register',old,keys.privateKey,spki),owner,()=>clock));
 const proof=response(id,'register',latest,keys.privateKey,spki);
 assert.throws(()=>completePairing(db,proof,owner,()=>({...clock,runtimeId:randomUUID()})));
 assert.throws(()=>completePairing(db,proof,owner,()=>({...clock,wall:clock.wall-1})));
 assert.throws(()=>completePairing(db,proof,owner,()=>({...clock,tick:clock.tick+PAIRING_CHALLENGE_TTL_MS})));
 let n=0;assert.throws(()=>completePairing(db,proof,owner,()=>++n===1?clock:{...clock,wall:clock.wall+PAIRING_CHALLENGE_TTL_MS}));
 assert.deepEqual(completePairing(db,proof,owner,()=>clock),{registered:true});db.close();
});
test('key substitution, curve mismatch and noncanonical input are rejected',()=>{
 const db=setup(),clock=makeClock(),id=randomUUID(),keys=keypair();register(db,id,keys,clock);
 assert.throws(()=>issuePairingChallenge(db,{deviceId:id,action:'register'},owner,clock));
 const id2=randomUUID(),challenge=issuePairingChallenge(db,{deviceId:id2,action:'register'},owner,clock);
 assert.throws(()=>completePairing(db,response(id2,'register',challenge,keys.privateKey,keys.publicKey.export({format:'der',type:'spki'})),owner,()=>clock));
 const wrong=generateKeyPairSync('ec',{namedCurve:'secp384r1'}),spki=wrong.publicKey.export({format:'der',type:'spki'});
 assert.throws(()=>completePairing(db,response(id2,'register',challenge,wrong.privateKey,spki),owner,()=>clock));
 assert.throws(()=>parsePairingComplete({deviceId:id.toUpperCase(),action:'session',challengeId:challenge.challengeId,payload:'',signature:'AA=='}));db.close();
});
test('a legacy device cannot be paired, including a claim made after challenge issuance',()=>{
 const db=setup(),clock=makeClock(),id=randomUUID(),id2=randomUUID(),keys=keypair();
 db.exec('CREATE TABLE camera_remote_devices(id TEXT PRIMARY KEY)');
 db.prepare('INSERT INTO camera_remote_devices(id) VALUES (?)').run(id);
 assert.throws(()=>issuePairingChallenge(db,{deviceId:id,action:'register'},owner,clock));
 const challenge=issuePairingChallenge(db,{deviceId:id2,action:'register'},owner,clock);
 db.prepare('INSERT INTO camera_remote_devices(id) VALUES (?)').run(id2);
 const spki=keys.publicKey.export({format:'der',type:'spki'});
 assert.throws(()=>completePairing(db,response(id2,'register',challenge,keys.privateKey,spki),owner,()=>clock));
 db.close();
});
