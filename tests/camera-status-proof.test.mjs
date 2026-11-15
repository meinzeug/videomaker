import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {statusProofTranscript,verifyStatusProof} from '../experiments/web-camera-status/status-proof.mjs';
const binding={owner:'a'.repeat(64),browserSession:'b'.repeat(64),deviceSession:'c'.repeat(64),cameraId:'00000000-0000-0000-0000-000000000001',prompterId:'00000000-0000-0000-0000-000000000002',pairEpoch:'00000000-0000-0000-0000-000000000003',requestId:'00000000-0000-0000-0000-000000000004',nonce:Buffer.alloc(32,1).toString('base64url')};
const state={revision:42,phase:'recording',recordingId:'00000000-0000-0000-0000-000000000005',projectKnown:true,projectId:'00000000-0000-0000-0000-000000000006',front:false};
const keypair=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {pair,pub:pair.publicKey.export({format:'der',type:'spki'})};};
test('valid P-256 proof binds status and all pair/session/request fields',()=>{
 const {pair,pub}=keypair(), bytes=statusProofTranscript(binding,state),sig=sign('sha256',bytes,pair.privateKey);
 assert.equal(verifyStatusProof(binding,state,pub,sig),true);
 for(const [field,value] of Object.entries({owner:'d'.repeat(64),browserSession:'e'.repeat(64),deviceSession:'f'.repeat(64),cameraId:binding.requestId,prompterId:binding.requestId,pairEpoch:binding.requestId,requestId:binding.pairEpoch,nonce:Buffer.alloc(32,2).toString('base64url')}))assert.equal(verifyStatusProof({...binding,[field]:value},state,pub,sig),false,field);
 for(const [field,value] of Object.entries({revision:43,phase:'paused',recordingId:binding.requestId,projectKnown:false,projectId:null,front:true}))assert.equal(verifyStatusProof(binding,{...state,[field]:value},pub,sig),false,field);
 assert.equal(verifyStatusProof(binding,state,keypair().pub,sig),false);
});
test('rejects impossible or noncanonical status without coercion',()=>{
 for(const s of [{...state,revision:0},{...state,revision:1.5},{...state,recordingId:null},{...state,phase:'idle'},{...state,projectKnown:false},{...state,front:'false'},{...state,extra:'x'}])assert.equal(statusProofTranscript(binding,s),null);
 for(const b of [{...binding,cameraId:binding.prompterId},{...binding,owner:binding.owner.toUpperCase()},{...binding,nonce:'x'.repeat(43)},{...binding,extra:'x'}])assert.equal(statusProofTranscript(b,state),null);
});
test('malformed signatures and wrong curves fail closed',()=>{
 const {pair}=keypair(),wrong=generateKeyPairSync('ec',{namedCurve:'secp384r1'}),sig=sign('sha256',statusProofTranscript(binding,state),pair.privateKey);
 assert.equal(verifyStatusProof(binding,state,wrong.publicKey.export({format:'der',type:'spki'}),sig),false);
 assert.equal(verifyStatusProof(binding,state,Buffer.from('bad'),sig),false);
 assert.equal(verifyStatusProof(binding,state,pair.publicKey.export({format:'der',type:'spki'}),Buffer.alloc(81)),false);
});
test('shared JVM and server public fixture has identical transcript and verifies',async()=>{
 const {createHash}=await import('node:crypto');
 const data=statusProofTranscript(binding,state),pub=Buffer.from('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHAYt0AYAlUXbu087VXPuHHRDEeso8RxG+V5Wh7zKaOQrt9vWx2eXwkEIsnVbVR8E7CKbk58EgUhxJweLXW2Qyg==','base64');
 const sig=Buffer.from('MEUCIGGngfEazx6T85O/vaNt40YLw8pzzFtzLyEkmYP2eFOtAiEAnDlyBoxHCWmQLmFL2Bhh5/g1hjeS3K8DBFuxD4tZdNg=','base64');
 assert.equal(createHash('sha256').update(data).digest('hex'),'bb3740e5796162f5c1a546a3285cb8f5cd4f6fac4deb816894bf352a34e79d14');
 assert.equal(verifyStatusProof(binding,state,pub,sig),true);
});
