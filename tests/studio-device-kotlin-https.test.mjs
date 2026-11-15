import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:https';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';
import {createDeviceHttpFixture} from '../experiments/studio-device-http/router.mjs';

const classes=process.env.STUDIO_DEVICE_HTTPS_JVM_CLASSES,stdlib=process.env.STUDIO_DEVICE_HTTPS_STDLIB,gson=process.env.STUDIO_DEVICE_HTTPS_GSON;
const enabled=typeof classes==='string'&&classes.startsWith('/dev/shm/studio-device-https-client.')&&
 typeof stdlib==='string'&&stdlib.startsWith('/home/dennis/.gradle/')&&typeof gson==='string'&&gson.startsWith('/home/dennis/.gradle/');
test('TLS fixture rejects wrong trust, same-CA wrong leaf and wrong hostname before HTTP',{skip:!enabled,timeout:30000},async()=>{
 const root=mkdtempSync('/dev/shm/studio-device-https-server.'),files=[];
 const generate=(name,ip='127.0.0.1')=>{
  const key=join(root,name+'-key.pem'),cert=join(root,name+'-cert.pem');files.push(key,cert);
  const result=spawnSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj',`/CN=${ip}`,'-addext',`subjectAltName=IP:${ip}`,'-keyout',key,'-out',cert],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,'synthetic TLS certificate generation failed');return {key,cert};
 };
 const servers=[];let db,child;
 try{
  const good=generate('good'),wrong=generate('wrong'),wrongHost=generate('wronghost','127.0.0.2');
  const alt={key:join(root,'alt-key.pem'),csr:join(root,'alt.csr'),cert:join(root,'alt-cert.pem'),ext:join(root,'alt.ext')};files.push(...Object.values(alt));
  const createCsr=spawnSync('openssl',['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=127.0.0.1','-keyout',alt.key,'-out',alt.csr],{encoding:'utf8',timeout:10000});assert.equal(createCsr.status,0);
  writeFileSync(alt.ext,'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n');
  const issue=spawnSync('openssl',['x509','-req','-in',alt.csr,'-CA',good.cert,'-CAkey',good.key,'-set_serial','2','-days','1','-extfile',alt.ext,'-out',alt.cert],{encoding:'utf8',timeout:10000});assert.equal(issue.status,0);
  db=new Database(':memory:');initializeStudioDeviceAuth(db);db.exec('CREATE TABLE fixture_browser_sessions(token_hash TEXT PRIMARY KEY,csrf_hash TEXT NOT NULL)');
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),hash=x=>createHash('sha256').update(x).digest('hex');
  db.prepare('INSERT INTO fixture_browser_sessions VALUES(?,?)').run(hash(token),hash(csrf));
  const handler=createDeviceHttpFixture({db,challengeSecret:randomBytes(32),ownerSecret:randomBytes(32)}),counts=[0,0,0];
  const specs=[{key:good.key,cert:readFileSync(good.cert)},{key:alt.key,cert:Buffer.concat([readFileSync(alt.cert),readFileSync(good.cert)])},{key:wrongHost.key,cert:readFileSync(wrongHost.cert)}];
  for(let i=0;i<specs.length;i++){
   const spec=specs[i],server=createServer({key:readFileSync(spec.key),cert:spec.cert,minVersion:'TLSv1.3'},(req,res)=>{counts[i]++;handler(req,res);});servers.push(server);
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  const bases=servers.map(server=>`https://127.0.0.1:${server.address().port}`);
  child=spawn('java',['-Xmx96m','-XX:ActiveProcessorCount=1','-Dsun.net.http.allowRestrictedHeaders=true','-Djdk.tls.client.protocols=TLSv1.3','-cp',`${classes}:${stdlib}:${gson}`,'de.kontrakurs.kontraprompter.cloud.DeviceHttpsFixtureKt',bases[0],good.cert,wrong.cert,token,csrf,bases[1],bases[2],wrongHost.cert],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x.toString();});child.stderr.on('data',x=>{stderr+=x.toString();});
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  assert.deepEqual(result,{code:0,signal:null},stderr.slice(-2000));assert.match(stdout,/^DEVICE_HTTPS_FIXTURE_OK\s*$/);
  assert.deepEqual(counts,[7,1,0],'only the explicit trust-only control may reach the alternate server');
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
  for(const server of servers)if(server.listening)await new Promise(resolve=>server.close(resolve));if(db)db.close();
  for(const file of files)if(existsSync(file))unlinkSync(file);rmdirSync(root);
 }
});
