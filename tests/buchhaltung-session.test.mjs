import assert from 'node:assert/strict';
import {test} from 'node:test';
import {internalSessionSecretConfigured,internalSessionSecretValid} from '../lib/buchhaltung-session.ts';

test('internal session checks reject absent or weak configuration',()=>{
 for(const secret of [undefined,'','short','x'.repeat(257)]){
  assert.equal(internalSessionSecretConfigured(secret),false);
  assert.equal(internalSessionSecretValid(secret,secret??null),false);
 }
});
test('internal session checks require the exact shared secret',()=>{
 const secret='a'.repeat(32);
 assert.equal(internalSessionSecretConfigured(secret),true);
 for(const value of [null,'','a'.repeat(31),'b'.repeat(32),secret+'x','a'.repeat(257)])assert.equal(internalSessionSecretValid(secret,value),false);
 assert.equal(internalSessionSecretValid(secret,secret),true);
});
