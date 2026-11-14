import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cameraStartWasRefused} from '../lib/camera-ui-state.ts';
test('only matching confirmed rejection or proven non-delivery releases a pending start',()=>{
 for(const result of ['rejected','expired'])assert.equal(cameraStartWasRefused({id:'a',result},'a'),true);
 assert.equal(cameraStartWasRefused({id:'a',result:'server_expired',neverDelivered:1},'a'),true);
 for(const command of [null,{id:'a',result:'server_expired'},{id:'a',result:'accepted'},{id:'b',result:'rejected'},{id:'a',result:'queued'}])assert.equal(cameraStartWasRefused(command,'a'),false);
});
