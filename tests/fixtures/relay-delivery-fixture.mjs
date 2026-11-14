import Database from 'better-sqlite3';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {OpaqueRendezvous} from '../../lib/opaque-rendezvous.ts';
import {AuthorizedRelayDelivery} from '../../lib/relay-delivery.ts';
import {beginRelayPairing,completeRelayPairing,relayPairingMessage} from '../../lib/relay-pairing-registry.ts';
import {beginRelaySession,completeRelaySession,relaySessionMessage} from '../../lib/relay-session-authorization.ts';
import {registerRelayBrowserSession,resolveRelayBrowserSession} from '../../lib/relay-browser-sessions.ts';
import {sessionRevoked} from '../../lib/session-revocations.ts';

export function fixture(){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');
 const owner='a'.repeat(64),secret='fixture-session-secret-at-least-32-characters',runtimeId=randomUUID();
 const clock=()=>({runtimeId,wall:1023,tick:1023}),wall=()=>1023;
 const relay=new OpaqueRendezvous(()=>1023),room=relay.create(owner),guestCredential=randomBytes(32).toString('base64url');
 relay.join(room.roomId,room.joinTicket,guestCredential);
 const camera={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})},prompter={deviceId:randomUUID(),keys:generateKeyPairSync('ec',{namedCurve:'prime256v1'})};
 for(const d of [camera,prompter])d.publicKey=d.keys.publicKey.export({format:'der',type:'spki'});
 const pairId=randomUUID(),transcript='d'.repeat(64),challenge=beginRelayPairing(db,owner,pairId,transcript,clock,()=>true);
 const message=role=>relayPairingMessage(owner,pairId,challenge.challengeId,challenge.nonce,transcript,camera.deviceId,camera.publicKey,prompter.deviceId,prompter.publicKey,role);
 completeRelayPairing(db,owner,{pairId,challengeId:challenge.challengeId,transcriptHash:transcript,camera:{...camera,signature:sign('sha256',message('camera'),camera.keys.privateKey)},prompter:{...prompter,signature:sign('sha256',message('prompter'),prompter.keys.privateKey)}},clock,()=>true);
 sessionRevoked(db,secret,'initialize-fixture');
 for(const [device,role] of [[camera,'camera'],[prompter,'prompter']]){
  const body=`10000.${randomBytes(18).toString('base64url')}`;device.cookie=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
  device.session=registerRelayBrowserSession(db,secret,device.cookie,owner,wall);
  const credential=randomBytes(32).toString('base64url'),request={pairId,deviceId:device.deviceId,role,roomId:room.roomId,tokenHash:createHash('sha256').update(credential).digest('hex')};
  const c=beginRelaySession(db,owner,device.session,request,clock,()=>true);
  const proof=sign('sha256',relaySessionMessage(owner,device.session,request,c.challengeId,c.nonce),device.keys.privateKey);
  completeRelaySession(db,owner,device.session,request,c.challengeId,proof,clock,()=>true);
  device.participant={session:device.session,request,credential,authorize:()=>resolveRelayBrowserSession(db,secret,owner,device.session,wall)};
 }
 const delivery=new AuthorizedRelayDelivery(db,relay,secret,clock,wall);
 return {db,owner,secret,relay,room,camera,prompter,delivery,cameraActor:{role:'owner',owner},guestActor:{role:'guest',credential:guestCredential}};
}
