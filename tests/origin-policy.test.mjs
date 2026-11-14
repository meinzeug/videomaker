import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuredSameOrigin,sameOriginPolicy} from '../lib/origin-policy.ts';

test('configured origin compares scheme, host, and effective port',()=>{
 assert.equal(configuredSameOrigin('https://videomaker.dorfspy.de','videomaker.dorfspy.de','https://videomaker.dorfspy.de'),true);
 assert.equal(configuredSameOrigin('https://videomaker.dorfspy.de:443','videomaker.dorfspy.de:443','https://videomaker.dorfspy.de'),true);
 assert.equal(configuredSameOrigin('http://videomaker.dorfspy.de','videomaker.dorfspy.de','https://videomaker.dorfspy.de'),false);
 assert.equal(configuredSameOrigin('https://videomaker.dorfspy.de:444','videomaker.dorfspy.de','https://videomaker.dorfspy.de'),false);
 assert.equal(configuredSameOrigin('https://videomaker.dorfspy.de','videomaker.dorfspy.de:444','https://videomaker.dorfspy.de'),false);
 assert.equal(configuredSameOrigin('https://evil.example','videomaker.dorfspy.de','https://videomaker.dorfspy.de'),false);
 assert.equal(configuredSameOrigin('https://videomaker.dorfspy.de','evil.example','https://videomaker.dorfspy.de'),false);
});

test('configured mode ignores spoofed forwarding headers',()=>{
 const expected='https://videomaker.dorfspy.de';
 assert.equal(sameOriginPolicy('http://videomaker.dorfspy.de','videomaker.dorfspy.de','videomaker.dorfspy.de',expected),false);
 assert.equal(sameOriginPolicy('https://evil.example','videomaker.dorfspy.de','evil.example',expected),false);
 assert.equal(sameOriginPolicy(expected,'evil.example','videomaker.dorfspy.de',expected),false);
 assert.equal(sameOriginPolicy(expected,'videomaker.dorfspy.de','evil.example',expected),true);
});

test('invalid or ambiguous Origin and Host values fail closed',()=>{
 const expected='https://videomaker.dorfspy.de';
 for(const value of [null,'','null','https://videomaker.dorfspy.de/','https://videomaker.dorfspy.de/path','https://videomaker.dorfspy.de?x=1','https://videomaker.dorfspy.de#x','https://user@videomaker.dorfspy.de','https://videomaker.dorfspy.de https://evil.example','https://videomaker.dorfspy.de,https://evil.example','https://videomaker.dorfspy.de\n'])
  assert.equal(configuredSameOrigin(value,'videomaker.dorfspy.de',expected),false,String(value));
 for(const value of [null,'','videomaker.dorfspy.de:','videomaker.dorfspy.de,evil.example','user@videomaker.dorfspy.de','videomaker.dorfspy.de/path','videomaker.dorfspy.de\n'])
  assert.equal(configuredSameOrigin(expected,value,expected),false,String(value));
 for(const value of ['', 'null', 'https://videomaker.dorfspy.de/', 'https://videomaker.dorfspy.de/path','https://user@videomaker.dorfspy.de','https://@videomaker.dorfspy.de','https://videomaker.dorfspy.de:'])
  assert.equal(sameOriginPolicy(expected,'videomaker.dorfspy.de',null,value),false,value);
});

test('local HTTP, IPv6 and explicit HTTPS proxy fixtures can set their own origin',()=>{
 assert.equal(configuredSameOrigin('http://127.0.0.1:3337','127.0.0.1:3337','http://127.0.0.1:3337'),true);
 assert.equal(configuredSameOrigin('http://[::1]:3337','[::1]:3337','http://[::1]:3337'),true);
 assert.equal(configuredSameOrigin('https://device-test.local:4443','device-test.local:4443','https://device-test.local:4443'),true);
 assert.equal(configuredSameOrigin('http://device-test.local:4443','device-test.local:4443','https://device-test.local:4443'),false);
});

test('unconfigured installations retain the existing host-only behaviour',()=>{
 assert.equal(sameOriginPolicy('http://example.test','example.test',null,undefined),true);
 assert.equal(sameOriginPolicy('http://example.test','internal.test','example.test',undefined),true);
 assert.equal(sameOriginPolicy('https://example.test','example.test',null,undefined),true);
 assert.equal(sameOriginPolicy(null,'example.test',null,undefined),false);
 assert.equal(sameOriginPolicy('not-an-origin','example.test',null,undefined),false);
});
