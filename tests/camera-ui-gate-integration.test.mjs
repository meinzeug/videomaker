// Optional, explicitly isolated fixture. Never sends credentials to a remote host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';

const base=process.env.CAMERA_UI_GATE_SERVER,dir=process.env.CAMERA_UI_GATE_DATA_DIR,expected=process.env.CAMERA_UI_GATE_EXPECT_ENABLED;
const enabled=base==='http://127.0.0.1:3354'&&typeof dir==='string'&&['0','1'].includes(expected);
test('server-rendered camera UI gate matches isolated camera API',{skip:!enabled,timeout:30000},async()=>{
 const resolved=realpathSync(dir);
 assert.equal(path.dirname(resolved),realpathSync(tmpdir()));
 assert.match(path.basename(resolved),/^camera-ui-gate-[A-Za-z0-9]+$/);
 assert.equal(readFileSync(path.join(resolved,'disposable-fixture'),'utf8'),'camera-ui-gate-fixture\n');
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'camera-ui-gate-test'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const page=await fetch(base+'/',{headers:{cookie},cache:'no-store'});assert.equal(page.status,200);
 const html=await page.text();assert.ok(html.includes(`\\"cameraRemoteEnabled\\":${expected==='1'}`),'server must pass the runtime flag to Studio');
 const devices=await fetch(base+'/api/camera-devices',{headers:{cookie},cache:'no-store'});
 assert.equal(devices.status,expected==='1'?200:404);
 const alerts=await fetch(base+'/api/camera-devices/alerts',{headers:{cookie},cache:'no-store'});
 assert.equal(alerts.status,expected==='1'?200:404);
});
