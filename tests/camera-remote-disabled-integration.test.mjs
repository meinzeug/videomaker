// Run only against a dedicated local test server started WITHOUT CAMERA_REMOTE_TEST_ENABLE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const base=process.env.CAMERA_REMOTE_DISABLED_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3331'&&process.env.CAMERA_REMOTE_DISABLED_TEST_ALLOW_WRITES==='1';
test('camera routes return 404 by default without activating storage or commands',{skip:!enabled,timeout:30000},async()=>{
 for(const [path,method] of [['/api/camera-devices','GET'],['/api/camera-devices/alerts','GET'],['/api/camera-devices/claims?projectId=00000000-0000-4000-8000-000000000001','GET'],['/api/camera-devices/poll','POST'],['/api/camera-devices/pairing/challenge','POST'],['/api/camera-devices/pairing/complete','POST'],['/api/camera-devices/00000000-0000-4000-8000-000000000001/commands','POST'],['/api/camera-devices/00000000-0000-4000-8000-000000000001/resolve','POST']]){
  const response=await fetch(base+path,{method,headers:method==='POST'?{'content-type':'application/json',origin:base}:{},...(method==='POST'?{body:'{}'}:{})});
  assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'private, no-store');
 }
});
