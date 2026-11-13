import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseChannel,parseChannelIds} from '../lib/channels.ts';
test('channel names and platforms are validated and trimmed',()=>{
 assert.deepEqual(parseChannel({name:' News ',platform:'youtube',handle:' @news '}),{name:'News',platform:'youtube',handle:'@news'});
 assert.throws(()=>parseChannel({name:' ',platform:'youtube',handle:''}));
 assert.deepEqual(parseChannel({name:'Name',platform:' Twitch ',handle:''}),{name:'Name',platform:'Twitch',handle:''});
 assert.throws(()=>parseChannel({name:'Name',platform:' ',handle:''}));
 assert.throws(()=>parseChannel({name:'Name',platform:'foo\nbar',handle:''}));
 assert.throws(()=>parseChannel({name:'Name',platform:'youtube',handle:'x'.repeat(101)}));
});
test('project assignments accept valid IDs once and reject invalid IDs',()=>{
 const id='12c3267c-c343-41d1-8245-2a88107e7213';
 assert.deepEqual(parseChannelIds([id,id]),[id]);
 assert.deepEqual(parseChannelIds([]),[]);
 assert.throws(()=>parseChannelIds(['../bad']));
 assert.throws(()=>parseChannelIds(Array(101).fill(id)));
});
