// Opt-in fixture: separate loopback Next server, synthetic SQLite DB and network-blocking mock.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
const enabled=process.env.INDEPENDENT_TARGETED_HTTP_TEST==='1';
const root=resolve(process.env.GROK_TEST_ROOT||process.cwd());
const require=createRequire(join(resolve(process.env.GROK_TEST_DEPENDENCIES||root),'package.json'));
const Database=require('better-sqlite3'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok)});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
test('completed corrected project retains the original without changing teleprompter text',{skip:!enabled,timeout:180000},async()=>{
 if(process.platform!=='linux')throw Error('Linux process groups required');
 const dir=mkdtempSync(join(tmpdir(),'grok-targeted-http-'));mkdirSync(join(dir,'data'));writeFileSync(join(dir,'marker'),'independent-targeted-fixture\n');
 const port=await freePort(),origin=`http://127.0.0.1:${port}`,mock=join(process.cwd(),'tests/fixtures/independent-targeted-mock.cjs'),next=join(root,'node_modules/next/dist/bin/next');
 let child,db,log='',cookie='';
 async function call(url,method='GET',body){const headers={Origin:origin};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';const r=await fetch(origin+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};}
 try{
  child=spawn(process.execPath,[next,'dev','-H','127.0.0.1','-p',String(port)],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'development',DATA_DIR:join(dir,'data'),ADMIN_PASSWORD:'fixture-only-password',SESSION_SECRET:'fixture-only-secret-012345678901234567890',OPENROUTER_API_KEY:'fake-test-key',INDEPENDENT_TARGETED_FIXTURE:dir,VIDEOMAKER_PUBLIC_ORIGIN:origin,NODE_OPTIONS:`--require=${mock}`}});
  child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
  let ready=false;for(let i=0;i<900;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error(`Fixture failed: ${log.slice(-1200)}`);if(log.includes('Ready'))try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await sleep(50)}assert.ok(ready,'fixture did not start');
  assert.equal((await call('/api/projects')).status,401,'project contents must require authentication');
  assert.equal((await call('/api/login','POST',{password:'fixture-only-password'})).status,200);
  db=new Database(join(dir,'data','videomaker.sqlite'),{fileMustExist:true});
  const researchId=randomUUID(),source='https://example.org/source';
  db.prepare('INSERT INTO research_reports(id,created_at,sources,report) VALUES(?,?,?,?)').run(researchId,new Date().toISOString(),JSON.stringify([{title:'Test',url:source,source:'Test',date:'',description:'Test'}]),JSON.stringify({sources:[{url:source}],source_excerpts:[{url:source,status:'retrieved',text:'Luisa Neubauer sagt: „Synthetischer Fakt.“'}]}));
  const generated=await call('/api/generate','POST',{researchId,imageMode:'descriptions'});
  assert.equal(generated.status,200,JSON.stringify(generated.data));
  const original='Originaler erster Teil.\n\nZitat: „Erfundener Wortlaut.“',corrected='Originaler erster Teil.\n\nLuisa Neubauer sagt: „Synthetischer Fakt.“';
  assert.equal(generated.data.content.script,corrected);assert.equal(generated.data.content.generation_original_script,original);
  assert.ok(generated.data.content.hinweise_fuer_dennis.some(x=>x.includes('Interner Testhinweis')));
  const loaded=(await call('/api/projects')).data.find(item=>item.id===generated.data.id);
  assert.ok(loaded);assert.equal(loaded.content.script,corrected);assert.equal(loaded.content.generation_original_script,original);
  const again=await call('/api/generate','POST',{researchId,imageMode:'descriptions'});
  assert.equal(again.status,200);assert.equal(again.data.id,generated.data.id);assert.equal(again.data.content.script,corrected);
  const phases=readFileSync(join(dir,'requests.log'),'utf8').trim().split('\n').map(JSON.parse).map(x=>x.phase).filter(x=>x!=='blocked-image-planning');
  assert.deepEqual(phases,['facts','part1','part2','repair']);
 }finally{
  db?.close();if(child&&child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,'SIGKILL');for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);}
  rmSync(dir,{recursive:true,force:true});
 }
});
