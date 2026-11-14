import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraLensChanged} from '../lib/camera-preview-reconnect.ts';
test('only a confirmed lens change of the same camera requests a reconnect',()=>{
 assert.equal(cameraLensChanged(null,{deviceId:'a',front:false}),false);
 assert.equal(cameraLensChanged({deviceId:'a',front:null},{deviceId:'a',front:true}),false);
 assert.equal(cameraLensChanged({deviceId:'a',front:false},{deviceId:'b',front:true}),false);
 assert.equal(cameraLensChanged({deviceId:'a',front:false},{deviceId:'a',front:false}),false);
 assert.equal(cameraLensChanged({deviceId:'a',front:false},{deviceId:'a',front:true}),true);
});
