import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settingConfirmed} from '../app/device-control-ack.ts';
test('matching stale value without the exact phone acknowledgement is never a confirmation',()=>{
 const pending={deviceId:'device-a',commandId:'command-a',field:'speed',value:76};
 const device={id:'device-a',speed:76,fontSize:44,acknowledged:[]};
 assert.equal(settingConfirmed(pending,device),false);
 assert.equal(settingConfirmed(pending,{...device,acknowledged:['old-command']}),false);
 assert.equal(settingConfirmed(pending,{...device,id:'device-b',acknowledged:['command-a']}),false);
 assert.equal(settingConfirmed(pending,{...device,speed:35,acknowledged:['command-a']}),false);
 assert.equal(settingConfirmed(pending,{...device,acknowledged:['command-a']}),true);
});
