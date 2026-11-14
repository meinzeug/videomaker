import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer as createControlServer} from 'node:net';
import {lstatSync,realpathSync,writeFileSync,unlinkSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {relayClock} from '../../lib/relay-clock.ts';
import Database from 'better-sqlite3';
import {initializeStudioRendezvousFixture} from './core.mjs';
import {createStudioRendezvousHttpFixture} from './http-fixture.mjs';

// Deliberately synthetic localhost-only fixture. No production cookies or persistent DB.
if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE!=='1')throw Error('STUDIO_RENDEZVOUS_FIXTURE_DISABLED');
const directory=process.argv[2];if(!directory||!directory.startsWith('/tmp/'))throw Error('PRIVATE_TMP_DIRECTORY_REQUIRED');
const dir=resolve(directory),st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(dir)!==dir||st.uid!==process.getuid()||(st.mode&0o077)!==0)throw Error('PRIVATE_TMP_DIRECTORY_REQUIRED');
const infoPath=join(dir,'fixture.json'),controlPath=join(dir,'control.sock');process.umask(0o077);
const sha=s=>createHash('sha256').update(s).digest('hex'),random=()=>randomBytes(32).toString('base64url'),ownerHash=sha(random());
const camera={cookie:`fixture_session=${random()}`,sessionHash:sha(random()),deviceId:randomUUID(),role:'camera'},prompter={cookie:`fixture_session=${random()}`,sessionHash:sha(random()),deviceId:randomUUID(),role:'prompter'};
const sessions=new Map([[camera.cookie,camera],[prompter.cookie,prompter]]),active=new Set([camera.sessionHash,prompter.sessionHash]),db=new Database(':memory:');db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);
const clock=relayClock,authorize=(owner,session)=>owner===ownerHash&&active.has(session);
const server=createStudioRendezvousHttpFixture({db,getPrincipal:req=>{const session=sessions.get(req.headers.cookie);return session?{ownerHash,sessionHash:session.sessionHash}:null;},authorize,clock,serverSecret:randomBytes(32)});
let stopping=false,started=false;
const control=createControlServer(socket=>{
 let buffer='';const timeout=setTimeout(()=>socket.destroy(),2000);socket.setEncoding('utf8');socket.on('error',()=>{});
 socket.on('data',data=>{buffer+=data;if(buffer.length>1024){socket.destroy();return;}if(!buffer.includes('\n'))return;
  try{const command=JSON.parse(buffer.split('\n')[0]);if(command.op==='revoke'&&['camera','prompter'].includes(command.role)){active.delete(command.role==='camera'?camera.sessionHash:prompter.sessionHash);socket.end('{"ok":true}\n');}
   else if(command.op==='stop'){socket.end('{"ok":true}\n');setImmediate(shutdown);}
   else socket.end('{"ok":false}\n');
  }catch{socket.end('{"ok":false}\n');}
 });socket.on('close',()=>clearTimeout(timeout));
});
function shutdown(){if(stopping)return;stopping=true;server.closeAllConnections?.();server.close();control.close(()=>{if(started){try{unlinkSync(infoPath);}catch{}try{unlinkSync(controlPath);}catch{}}db.close();});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
control.listen(controlPath,()=>{
 chmodSync(controlPath,0o600);server.listen(0,'127.0.0.1',()=>{
  const info={baseUrl:`http://127.0.0.1:${server.address().port}`,controlSocket:controlPath,camera:{cookie:camera.cookie,deviceId:camera.deviceId,role:camera.role},prompter:{cookie:prompter.cookie,deviceId:prompter.deviceId,role:prompter.role}};
  try{writeFileSync(infoPath,JSON.stringify(info),{mode:0o600,flag:'wx'});started=true;process.stdout.write(`fixture ready; private credentials: ${infoPath}\n`);}catch{shutdown();}
 });
});
