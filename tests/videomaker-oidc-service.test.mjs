import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createConnection,createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {initializeProviderDatabase,openProviderDatabase} from '../lib/oidc-provider-database.mjs';
import {createVideomakerOidcService,validateVideomakerOidcConfig} from '../lib/videomaker-oidc-service.mjs';

test('OIDC-Konfiguration verlangt festen HTTPS-Issuer, exakten Callback und explizite starke Schlüssel',()=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...privateKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
 const config={issuer:'https://studio.example/oidc',redirect:'https://studio.example/buchhaltung/api/auth/callback/oidc',clientId:'haben',subject:'owner',email:'test@example.invalid',clientSecret:'c'.repeat(40),cacheKey:'k'.repeat(40),cookieKeys:['s'.repeat(40)],jwks:{keys:[jwk]}};
 assert.equal(validateVideomakerOidcConfig(config).issuer,config.issuer);
 for(const invalid of [
  {...config,issuer:'http://studio.example/oidc'}, {...config,issuer:'https://studio.example/anderes'},
  {...config,issuer:'http://127.0.0.1:3001/oidc'},
  {...config,redirect:'https://andere.example/buchhaltung/api/auth/callback/oidc'},
  {...config,redirect:'https://studio.example/buchhaltung/api/auth/callback/oidc?x=1'},
  {...config,clientId:undefined},{...config,subject:''},{...config,email:'kaputt'},
  {...config,clientSecret:'kurz'},{...config,cacheKey:'kurz'},{...config,cookieKeys:[]},
  {...config,jwks:{keys:[{...jwk,d:undefined}]}},{...config,jwks:{keys:[]}},
 ])assert.throws(()=>validateVideomakerOidcConfig(invalid));
 const weak=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({format:'jwk'});
 assert.throws(()=>validateVideomakerOidcConfig({...config,jwks:{keys:[{...weak,kid:'weak',alg:'RS256',use:'sig'}]}}),/kurz/);
});

test('Provider-Datenbank wird nur neu und geschützt angelegt, bestehende Fremddateien bleiben unangetastet',()=>{
 const dir=mkdtempSync(join(homedir(),'.videomaker-provider-db-test-'));
 const file=join(dir,'provider.sqlite'),foreign=join(dir,'foreign.sqlite'),link=join(dir,'link.sqlite');
 try{
  writeFileSync(foreign,'unrelated',{mode:0o600});
  assert.throws(()=>initializeProviderDatabase(foreign));assert.equal(readFileSync(foreign,'utf8'),'unrelated');
  initializeProviderDatabase(file);
  let db=openProviderDatabase(file);
  assert.equal(db.prepare('select version from videomaker_oidc_provider_marker').get().version,1);
  assert.ok(db.prepare("select 1 from sqlite_master where name='oidc_provider_session_map'").get());
  db.close();
  assert.throws(()=>initializeProviderDatabase(file));
  symlinkSync(file,link);assert.throws(()=>openProviderDatabase(link));
  chmodSync(file,0o644);assert.throws(()=>openProviderDatabase(file));chmodSync(file,0o600);
  db=openProviderDatabase(file);db.pragma('application_id = 0');db.close();
  assert.throws(()=>openProviderDatabase(file),/OIDC-Datenbank/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Einrichtungsskript schreibt ohne ausdrückliche Aktivierung keine Datenbank',()=>{
 const dir=mkdtempSync(join(homedir(),'.videomaker-provider-prepare-test-')),file=join(dir,'provider.sqlite');
 try{
  const env={...process.env,VIDEOMAKER_OIDC_DATABASE:file};delete env.VIDEOMAKER_OIDC_CREATE_DATABASE;
  const script=new URL('../scripts/prepare-videomaker-oidc-database.mjs',import.meta.url).pathname;
  const denied=spawnSync(process.execPath,['--experimental-strip-types',script],{env,encoding:'utf8'});
  assert.equal(denied.status,1);assert.equal(existsSync(file),false);
  const allowed=spawnSync(process.execPath,['--experimental-strip-types',script],{env:{...env,VIDEOMAKER_OIDC_CREATE_DATABASE:'1'},encoding:'utf8'});
  assert.equal(allowed.status,0,allowed.stderr);const db=openProviderDatabase(file);db.close();
  const repeated=spawnSync(process.execPath,['--experimental-strip-types',script],{env:{...env,VIDEOMAKER_OIDC_CREATE_DATABASE:'1'},encoding:'utf8'});
  assert.equal(repeated.status,1);const unchanged=openProviderDatabase(file);unchanged.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Dienst gibt bei fehlerhafter Konfiguration keine eingegebenen Geheimnisse aus',()=>{
 const secret='synthetisches-geheimnis-darf-nicht-im-log-stehen';
 const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('../scripts/videomaker-oidc-service.mjs',import.meta.url).pathname],{
  env:{...process.env,VIDEOMAKER_OIDC_JWKS:secret,VIDEOMAKER_OIDC_COOKIE_KEYS:secret},encoding:'utf8',
 });
 assert.equal(result.status,1);
 assert.equal(`${result.stdout}${result.stderr}`.includes(secret),false);
});

test('Dienst startet nur mit expliziter Konfiguration auf Loopback und veröffentlicht keine privaten Schlüssel',async()=>{
 const dir=mkdtempSync(join(homedir(),'.videomaker-provider-start-test-')),file=join(dir,'provider.sqlite');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...privateKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
 const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 initializeProviderDatabase(file);
 const env={...process.env,VIDEOMAKER_OIDC_DATABASE:file,VIDEOMAKER_OIDC_PORT:String(port),VIDEOMAKER_OIDC_ISSUER:'https://studio.example/oidc',
  VIDEOMAKER_OIDC_REDIRECT:'https://studio.example/buchhaltung/api/auth/callback/oidc',VIDEOMAKER_OIDC_CLIENT_ID:'haben',
  VIDEOMAKER_OIDC_CLIENT_SECRET:'c'.repeat(40),VIDEOMAKER_OIDC_SUBJECT:'owner',VIDEOMAKER_OIDC_EMAIL:'test@example.invalid',
  VIDEOMAKER_OIDC_CACHE_KEY:'k'.repeat(40),VIDEOMAKER_OIDC_COOKIE_KEYS:JSON.stringify(['s'.repeat(40)]),VIDEOMAKER_OIDC_JWKS:JSON.stringify({keys:[jwk]}),
  VIDEOMAKER_OIDC_BINDING_URL:'https://127.0.0.1:4443/api/internal/oidc/session-binding',
  VIDEOMAKER_OIDC_BINDING_SECRET:'b'.repeat(40),VIDEOMAKER_OIDC_BINDING_CA:'/kein-echter-test-aufruf.pem'};
 const child=spawn(process.execPath,['--experimental-strip-types',new URL('../scripts/videomaker-oidc-service.mjs',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
 try{
  let discovery;
  for(let attempt=0;attempt<60;attempt++){
   if(child.exitCode!==null)throw new Error(`Dienst startete nicht: ${output}`);
   try{
    const response=await fetch(`http://127.0.0.1:${port}/oidc/.well-known/openid-configuration`,{headers:{host:'studio.example','x-forwarded-host':'studio.example','x-forwarded-proto':'https'},signal:AbortSignal.timeout(500)});
    if(response.ok){discovery=await response.json();break;}
   }catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(discovery?.issuer,env.VIDEOMAKER_OIDC_ISSUER);
  const response=await fetch(`http://127.0.0.1:${port}/oidc/jwks`,{headers:{host:'studio.example','x-forwarded-host':'studio.example','x-forwarded-proto':'https'}});
  assert.equal(response.status,200);const publicKeys=await response.json();
  assert.equal(publicKeys.keys.length,1);assert.equal(publicKeys.keys[0].d,undefined);
  assert.equal(output.includes(env.VIDEOMAKER_OIDC_CLIENT_SECRET),false);
  assert.equal(output.includes(jwk.d),false);
  const partial=createConnection(port,'127.0.0.1');partial.on('error',()=>{});
  await new Promise((resolve,reject)=>{partial.once('connect',resolve);partial.once('error',reject);});
  partial.write('GET /oidc/jwks HTTP/1.1\r\nHost: studio.example\r\n');
  const ended=new Promise(resolve=>{if(child.exitCode!==null)return resolve(child.exitCode);child.once('exit',code=>resolve(code));});
  child.kill('SIGTERM');
  let timer;try{
   const code=await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Anbieter blieb mit offener Anfrage hängen')),7000);})]);
   assert.equal(code,0,'Dienst beendet sich trotz unvollständiger Anfrage');
  }finally{clearTimeout(timer);partial.destroy();}
 }finally{
  child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();});
  rmSync(dir,{recursive:true,force:true});
 }
},20_000);

test('OIDC-Fehlerseite gibt keine Requestdaten oder Stacks aus',async()=>{
 const dir=mkdtempSync(join(homedir(),'.videomaker-provider-errors-')),file=join(dir,'provider.sqlite');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...privateKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
 const config={issuer:'https://studio.example/oidc',redirect:'https://studio.example/buchhaltung/api/auth/callback/oidc',clientId:'haben',subject:'owner',email:'test@example.invalid',clientSecret:'c'.repeat(40),cacheKey:'k'.repeat(40),cookieKeys:['s'.repeat(40)],jwks:{keys:[jwk]}};
 initializeProviderDatabase(file);const db=openProviderDatabase(file);
 const service=createVideomakerOidcService(config,{db,binding:{issue:async()=> 'synthetische-referenz',check:async()=>true,match:async()=>true}});
 const server=createHttpServer((req,res)=>void service.handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const probeSecret='synthetische-ungewuenschte-requestdaten';
  const denied=await fetch(`http://127.0.0.1:${server.address().port}/oidc/auth?client_id=${probeSecret}`,{headers:{host:'studio.example','x-forwarded-host':'studio.example','x-forwarded-proto':'https',cookie:'kontrakurs_session=synthetisch'}});
  const denial=await denied.text();assert.ok(denied.status>=400);assert.match(denial,/Die Anmeldung ist nicht möglich/);
  assert.equal(denial.includes(probeSecret),false);assert.equal(denial.includes('Error:'),false);
  assert.match(denied.headers.get('cache-control')||'',/no-store/i);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});}
},20_000);
