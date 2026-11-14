import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CameraPreviewError,cameraPreviewStore,resetCameraPreviewStore} from '../lib/camera-preview-store.ts';
import {protectPreviewTransaction} from '../lib/camera-preview-transaction.ts';

const clock={runtimeId:randomUUID(),wall:1000,tick:1000};
const mutate=()=>cameraPreviewStore().deviceExchange(randomUUID(),{sessionId:null,after:0,events:[],available:true},clock);

test('unexpected error after in-memory mutation discards the signaling generation',()=>{
 resetCameraPreviewStore();const before=cameraPreviewStore();
 assert.throws(()=>protectPreviewTransaction(work=>work('owner'),()=>{mutate();throw new Error('injected');}),/injected/);
 assert.notEqual(cameraPreviewStore(),before);
 assert.deepEqual(cameraPreviewStore().availableDevices(clock,'a'.repeat(64)).devices,[]);
});
test('failed database commit after successful mutation discards the signaling generation',()=>{
 resetCameraPreviewStore();const before=cameraPreviewStore();
 assert.throws(()=>protectPreviewTransaction(work=>{work('owner');throw new Error('commit failed');},mutate),/commit failed/);
 assert.notEqual(cameraPreviewStore(),before);
 assert.deepEqual(cameraPreviewStore().availableDevices(clock,'a'.repeat(64)).devices,[]);
});
test('expected invalid preview input does not reset unrelated signaling',()=>{
 resetCameraPreviewStore();const before=cameraPreviewStore();
 assert.throws(()=>protectPreviewTransaction(work=>work('owner'),()=>{throw new CameraPreviewError('invalid','expected');}),/expected/);
 assert.equal(cameraPreviewStore(),before);
});
