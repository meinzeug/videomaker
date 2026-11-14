import test from 'node:test';
import assert from 'node:assert/strict';
import {issueTurnRestCredential} from '../lib/turn-rest-credentials.ts';

const secret=Buffer.from('0123456789abcdef0123456789abcdef');
const id='12345678-1234-4abc-8def-123456789abc';

test('TURN REST username and HMAC match an independently calculated vector',()=>{
 assert.deepEqual(issueTurnRestCredential(secret,1700000000,3600,id),{
  username:`1700003600:${id}`,
  credential:'tCof0CH3QgjS3VnfSeR7yNy1vik=',
  expiresAt:1700003600,
 });
});
test('generated opaque identities are unique and do not embed the secret',()=>{
 const first=issueTurnRestCredential(secret,1700000000,300);
 const second=issueTurnRestCredential(secret,1700000000,300);
 assert.notEqual(first.username,second.username);
 assert.match(first.username,/^1700000300:[0-9a-f-]{36}$/);
 assert.equal(JSON.stringify(first).includes(secret.toString()),false);
});
test('invalid keys, lifetimes, overflows and unsafe identities are rejected',()=>{
 for(const key of [new Uint8Array(31),new Uint8Array(4097)])assert.throws(()=>issueTurnRestCredential(key,1,300,id));
 for(const [now,ttl] of [[-1,300],[1,299],[1,3601],[1,300.5],[NaN,300],[Number.MAX_SAFE_INTEGER,300]])assert.throws(()=>issueTurnRestCredential(secret,now,ttl,id));
 for(const bad of ['someone@example.org','123:extra','12345678-1234-4abc-8def-123456789abc\n'])assert.throws(()=>issueTurnRestCredential(secret,1,300,bad));
});
