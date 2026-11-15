// Isolated cryptographic fixture: no registry, session authentication, freshness or route.
import {createPublicKey,verify} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,NONCE=/^[A-Za-z0-9_-]{43}$/;
const PHASES=new Set(['idle','preparing','recording','paused','finalizing','ready','partial','failed']);
const NEED_TAKE=new Set(['preparing','recording','paused','finalizing','ready','partial']);
const fields=(value,names)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==names.slice().sort().join(','))return null;
 const out={};for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor||!('value' in descriptor))return null;out[name]=descriptor.value;}return out;
};
/** Canonical, bounded ASCII transcript; a signature alone is never an authorization. */
export function statusProofTranscript(binding,observation){
 try{
  const b=fields(binding,['owner','browserSession','deviceSession','cameraId','prompterId','pairEpoch','requestId','nonce']);
  const s=fields(observation,['revision','phase','recordingId','projectKnown','projectId','front']);
  if(!b||!s||![b.owner,b.browserSession,b.deviceSession].every(v=>typeof v==='string'&&HASH.test(v))||
    ![b.cameraId,b.prompterId,b.pairEpoch,b.requestId].every(v=>typeof v==='string'&&UUID.test(v))||b.cameraId===b.prompterId||
    typeof b.nonce!=='string'||!NONCE.test(b.nonce)||Buffer.from(b.nonce,'base64url').length!==32||Buffer.from(b.nonce,'base64url').toString('base64url')!==b.nonce||
    !Number.isSafeInteger(s.revision)||s.revision<1||!PHASES.has(s.phase)||
    !(s.recordingId===null||(typeof s.recordingId==='string'&&UUID.test(s.recordingId)))||
    (NEED_TAKE.has(s.phase)&&s.recordingId===null)||(s.phase==='idle'&&s.recordingId!==null)||
    typeof s.projectKnown!=='boolean'||!(s.projectId===null||(typeof s.projectId==='string'&&UUID.test(s.projectId)))||
    (!s.projectKnown&&s.projectId!==null)||(s.projectKnown&&s.recordingId===null)||!(s.front===null||typeof s.front==='boolean'))return null;
  const value=['videomaker-camera-status-proof/v1',b.owner,b.browserSession,b.deviceSession,b.cameraId,b.prompterId,b.pairEpoch,b.requestId,b.nonce,
    String(s.revision),s.phase,s.recordingId??'-',s.projectKnown?'1':'0',s.projectId??'-',s.front===null?'-':s.front?'1':'0',''].join('\n');
  return Buffer.from(value,'utf8');
 }catch{return null;}
}
/** Caller must supply a separately authenticated, current camera key and binding. */
export function verifyStatusProof(binding,observation,publicKeyDer,signature){
 try{
  const text=statusProofTranscript(binding,observation);
  if(!text||!Buffer.isBuffer(publicKeyDer)||publicKeyDer.length>256||!Buffer.isBuffer(signature)||signature.length<1||signature.length>80)return false;
  const key=createPublicKey({key:publicKeyDer,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!Buffer.from(key.export({format:'der',type:'spki'})).equals(publicKeyDer))return false;
  return verify('sha256',text,{key,dsaEncoding:'der'},signature);
 }catch{return false;}
}
