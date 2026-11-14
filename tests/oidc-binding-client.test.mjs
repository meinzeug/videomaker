import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {createOidcBindingClient} from '../lib/oidc-binding-client.ts';

test('TLS-gebundener Sitzungsclient übermittelt nur gültige Protokollanfragen',async()=>{
 const directory=mkdtempSync(join(homedir(),'.videomaker-oidc-test-'));
 const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=videomaker-session.internal','-addext','subjectAltName=DNS:videomaker-session.internal'],{stdio:'ignore'});
 chmodSync(cert,0o600);
 const seen=[],reference='r'.repeat(43),secret='synthetisches-internes-test-secret-123456789';
 const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  seen.push({op:req.headers['x-oidc-binding-operation'],cookie:req.headers.cookie,reference:req.headers['x-oidc-session-reference'],secret:req.headers['x-videomaker-internal-secret'],length:req.headers['content-length']});
  if(req.headers['x-oidc-binding-operation']==='issue'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({reference}));return;}
  const accepted=req.headers['x-oidc-binding-operation']==='check'||
   (req.headers['x-oidc-binding-operation']==='match'&&req.headers.cookie==='kontrakurs_session=abc.def'&&req.headers['x-oidc-session-reference']===reference);
  res.writeHead(accepted?204:401).end();
 });
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`https://127.0.0.1:${server.address().port}/api/internal/oidc/session-binding`;
  const config={endpoint,secret,caFile:cert};
  const client=createOidcBindingClient(config);
  config.secret='ausgetauschter-wert-nicht-benutzen';
  config.caFile='/nicht-vorhanden';
  assert.equal(await client.issue('kontrakurs_session=abc.def'),reference);
  assert.equal(await client.check(reference),true);
  assert.equal(await client.reset('kontrakurs_session=abc.def'),false);
  assert.equal(await client.match(reference,'kontrakurs_session=abc.def'),true);
  assert.equal(await client.match(reference,'kontrakurs_session=anderes.cookie'),false);
  assert.equal(await client.match('ungueltig','kontrakurs_session=abc.def'),false);
  assert.equal(await client.match(reference,'kontrakurs_session=abc; other=secret'),false);
  assert.equal(await client.issue('kontrakurs_session=abc; other=secret'),null);
  assert.equal(await client.check('invalid'),false);
  assert.equal(seen.length,5);
  assert.deepEqual(seen.map(item=>item.op),['issue','check','reset','match','match']);
  assert.ok(seen.every(item=>item.secret===secret&&item.length==='0'));
  assert.equal(seen[1].cookie,undefined);assert.equal(seen[1].reference,reference);
  assert.equal(seen[3].cookie,'kontrakurs_session=abc.def');assert.equal(seen[3].reference,reference);
  assert.throws(()=>createOidcBindingClient({endpoint:endpoint.replace('https:','http:'),secret,caFile:cert}),/endpunkt/i);
  assert.throws(()=>createOidcBindingClient({endpoint:endpoint.replace('127.0.0.1','example.com'),secret,caFile:cert}),/endpunkt/i);
  assert.throws(()=>createOidcBindingClient({endpoint:endpoint+'?x=1',secret,caFile:cert}),/endpunkt/i);
  const link=join(directory,'ca-link.pem');symlinkSync(cert,link);
  await assert.rejects(createOidcBindingClient({endpoint,secret,caFile:link}).issue('kontrakurs_session=abc.def'));
  const untrusted=join(directory,'untrusted.pem');writeFileSync(untrusted,'not a certificate');chmodSync(untrusted,0o600);
  await assert.rejects(createOidcBindingClient({endpoint,secret,caFile:untrusted}).issue('kontrakurs_session=abc.def'));
  const otherKey=join(directory,'other-key.pem'),otherCert=join(directory,'other-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',otherKey,'-out',otherCert,'-days','1','-subj','/CN=wrong.invalid','-addext','subjectAltName=DNS:wrong.invalid'],{stdio:'ignore'});
  chmodSync(otherCert,0o600);
  await assert.rejects(createOidcBindingClient({endpoint,secret,caFile:otherCert}).issue('kontrakurs_session=abc.def'));
  let wrongNameRequests=0;
  const wrongName=createServer({key:readFileSync(otherKey),cert:readFileSync(otherCert)},(_req,res)=>{wrongNameRequests++;res.writeHead(200).end();});
  try{
   await new Promise(resolve=>wrongName.listen(0,'127.0.0.1',resolve));
   const wrongEndpoint=`https://127.0.0.1:${wrongName.address().port}/api/internal/oidc/session-binding`;
   await assert.rejects(createOidcBindingClient({endpoint:wrongEndpoint,secret,caFile:otherCert}).issue('kontrakurs_session=abc.def'));
   assert.equal(wrongNameRequests,0,'Bei falschem TLS-Namen keine Zugangsdaten senden');
  }finally{await new Promise(resolve=>wrongName.close(resolve));}
  assert.equal(seen.length,5,'Bei ungültiger Gegenstelle keine Zugangsdaten senden');
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
