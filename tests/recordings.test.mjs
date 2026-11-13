import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecordingId, parseRange } from '../lib/recordings.ts';

test('video playback supports bounded, open-ended and suffix byte ranges',()=>{
 assert.deepEqual(parseRange('bytes=0-31',100),{start:0,end:31});
 assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99});
 assert.deepEqual(parseRange('bytes=-20',100),{start:80,end:99});
 assert.deepEqual(parseRange('bytes=90-999',100),{start:90,end:99});
});
test('invalid and unsatisfiable byte ranges are rejected',()=>{
 for(const value of ['bytes=100-','bytes=50-40','bytes=-0','bytes=0-1,3-4','bytes=-','other=0-1','bytes=999999999999999999999-']) assert.equal(parseRange(value,100),null);
});
test('recording identifiers cannot escape the storage directory',()=>{
 assert.equal(isRecordingId('67e55044-10b1-426f-9247-bb680e5fe0c8'),true);
 for(const value of ['../../outside','not-a-uuid','67e55044-10b1-426f-9247-bb680e5fe0c8/../../x'])assert.equal(isRecordingId(value),false);
});
