import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sha256Blob,recordingReceiptMatches} from '../lib/blob-digest.ts';

test('incremental digest spans chunk boundaries and matches a standard SHA-256',async()=>{
 const input=Buffer.alloc(2*1024*1024+17);for(let i=0;i<input.length;i++)input[i]=i%251;
 const blob=new Blob([input]);const expected=createHash('sha256').update(input).digest('hex');
 assert.equal(await sha256Blob(blob),expected);
 await assert.rejects(sha256Blob(blob,()=>true));
});
test('success requires exact recording, project, size and local digest',()=>{
 const expected={id:'r',projectId:'p',sizeBytes:123,sha256:'a'.repeat(64)};
 assert.equal(recordingReceiptMatches(expected,expected),true);
 for(const patch of [{id:'other'},{projectId:'other'},{sizeBytes:124},{sha256:'b'.repeat(64)}])assert.equal(recordingReceiptMatches({...expected,...patch},expected),false);
 assert.equal(recordingReceiptMatches(null,expected),false);
});
