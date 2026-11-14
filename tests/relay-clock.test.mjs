import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {relayClock} from '../lib/relay-clock.ts';
test('workers share a boot identity and comparable boot-time clocks',()=>{
 const before=relayClock();
 const source="import {relayClock} from './lib/relay-clock.ts'; process.stdout.write(JSON.stringify(relayClock()));";
 const child=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{encoding:'utf8'}));
 const after=relayClock();assert.equal(before.runtimeId,child.runtimeId);assert.equal(after.runtimeId,child.runtimeId);
 assert.ok(child.tick>=before.tick&&child.tick<=after.tick);
});
