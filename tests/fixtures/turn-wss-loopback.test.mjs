/** Isolated experiment, not production transport or an authentication design. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer as createHttpsServer} from 'node:https';
import {createServer as createTcpServer,createConnection} from 'node:net';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {issueTurnRestCredential} from '../../lib/turn-rest-credentials.ts';
import {bridgeTestOnly,createBoundedFixtureServer,FRAME_BYTES} from '../../experiments/turn-wss/bridge.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_TURN_WSS_FIXTURE='1';

const require=createRequire(process.env.VIDEOMAKER_TEST_REQUIRE_FROM||import.meta.url);
const {WebSocket,WebSocketServer,createWebSocketStream}=require('next/dist/compiled/ws');
const MAX_FRAME=FRAME_BYTES,MAX_TOTAL=8*1024*1024;
const token=randomBytes(32).toString('base64url');
const tokenMatches=value=>{
 const supplied=Buffer.from(typeof value==='string'?value:'');const expected=Buffer.from(`Bearer ${token}`);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
};
const waitFor=async(fn,ms=3000)=>{const until=Date.now()+ms;while(Date.now()<until){if(fn())return;await delay(20);}throw Error('fixture timeout');};
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const closeServer=async server=>{if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};

/** The production app never calls this test-only bridge. */
function bridge(ws,tcp,stats,idleMs=5000,signal,lifetimeMs=15000){
 const handle=bridgeTestOnly({websocket:ws,upstream:tcp,createWebSocketStream,idleMs,lifetimeMs,maxBytes:MAX_TOTAL,signal,
  onEvent(type){if(type==='websocket-backpressure')stats.inboundPauses++;if(type==='websocket-resumed')stats.inboundResumes++;if(type==='tcp-backpressure')stats.outboundPauses++;if(type==='tcp-resumed')stats.outboundResumes++;}});
 void handle.closed.then(reason=>{if(reason.endsWith('-limit'))stats.byteLimit++;});return handle;
}
function startTunnel(key,cert,upstream,maxConnections=8,idleMs=5000,signal,lifetimeMs=15000){
 const server=createHttpsServer({key,cert});const wss=createBoundedFixtureServer(WebSocketServer);
 const clients=new Set(),pending=new Set(),upstreams=new Set(),connections=new Set(),handles=new Set(),allHandles=[],stats={inboundPauses:0,inboundResumes:0,outboundPauses:0,outboundResumes:0,byteLimit:0};
 server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
 server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/fixture'||!tokenMatches(req.headers.authorization)||clients.size+pending.size>=maxConnections){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  pending.add(socket);socket.pause();
  const tcp=createConnection({host:'127.0.0.1',port:upstream,highWaterMark:1024});upstreams.add(tcp);
  tcp.once('close',()=>upstreams.delete(tcp));tcp.once('error',()=>{pending.delete(socket);socket.destroy();});
  socket.once('close',()=>{pending.delete(socket);if(!tcp.destroyed&&tcp.connecting)tcp.destroy();});
  tcp.once('connect',()=>{
   if(socket.destroyed){tcp.destroy();return;}pending.delete(socket);
   wss.handleUpgrade(req,socket,head,ws=>{clients.add(ws);ws.once('close',()=>clients.delete(ws));const handle=bridge(ws,tcp,stats,idleMs,signal,lifetimeMs);handles.add(handle);allHandles.push(handle);void handle.closed.then(()=>handles.delete(handle));socket.resume();});
  });
 });
 return {server,stats,clients,handles,allHandles,async close(){for(const ws of clients)ws.terminate();for(const tcp of upstreams)tcp.destroy();for(const socket of connections)socket.destroy();await closeServer(server);wss.close();}};
}
function wsClient(port,cert,auth=token){return new WebSocket(`wss://127.0.0.1:${port}/fixture`,{ca:cert,servername:'localhost',headers:{Authorization:`Bearer ${auth}`},perMessageDeflate:false,maxPayload:MAX_FRAME});}
async function rejected(ws){
 return new Promise(resolve=>{ws.once('open',()=>resolve(false));ws.once('error',()=>resolve(true));ws.once('unexpected-response',(_req,res)=>{res.resume();resolve(true);});});
}
function localProxy(tunnelPort,cert){
 const clients=new Set();const stats={inboundPauses:0,inboundResumes:0,outboundPauses:0,outboundResumes:0,byteLimit:0};
 const server=createTcpServer(socket=>{
  socket.pause();const ws=wsClient(tunnelPort,cert);clients.add(ws);ws.once('close',()=>clients.delete(ws));
  ws.once('open',()=>{bridge(ws,socket,stats);socket.resume();});
  ws.once('error',()=>socket.destroy());socket.once('close',()=>ws.terminate());
 });
 return {server,async close(){for(const ws of clients)ws.terminate();await closeServer(server);}};
}
async function openSocket(ws){await once(ws,'open');return ws;}

const temp=mkdtempSync(join(tmpdir(),'vm-wss-turn-fixture-'));chmodSync(temp,0o700);
const keyPath=join(temp,'key.pem'),certPath=join(temp,'cert.pem');
const keyResult=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
if(keyResult.status!==0)throw Error('openssl fixture setup failed');
const key=readFileSync(keyPath),cert=readFileSync(certPath);
process.once('exit',()=>rmSync(temp,{recursive:true,force:true}));

test('WSS fixture authenticates, limits frames, propagates backpressure and closes', {timeout:15000},async()=>{
 let pauseIncoming=false;let stalledPeer;
 const echo=createTcpServer(socket=>{socket.on('error',()=>{});socket.on('data',data=>socket.write(data));if(pauseIncoming){stalledPeer=socket;socket.pause();}});const echoPort=await listen(echo);
 const tunnel=startTunnel(key,cert,echoPort,1);const port=await listen(tunnel.server);
 try{
  assert.equal(await rejected(wsClient(port,cert,'wrong-fixture-token')),true);
  const untrusted=new WebSocket(`wss://127.0.0.1:${port}/fixture`,{servername:'localhost',headers:{Authorization:`Bearer ${token}`}});
  assert.equal(await rejected(untrusted),true);
  const ws=await openSocket(wsClient(port,cert));
  assert.equal(await rejected(wsClient(port,cert)),true); // bounded concurrent connections
  const body=randomBytes(60*1024);const received=once(ws,'message');ws.send(body,{binary:true});
  const [echoed,binary]=await received;assert.equal(binary,true);assert.equal(createHash('sha256').update(echoed).digest('hex'),createHash('sha256').update(body).digest('hex'));
  ws.close();await once(ws,'close');await waitFor(()=>tunnel.clients.size===0);
  const previousPauses=tunnel.stats.inboundPauses;
  pauseIncoming=true;const stalled=await openSocket(wsClient(port,cert));stalled.on('message',()=>{});
  for(let i=0;i<110;i++)stalled.send(body,{binary:true});
  await waitFor(()=>!!stalledPeer&&tunnel.stats.inboundPauses>previousPauses,5000);
  const previousResumes=tunnel.stats.inboundResumes;
  stalledPeer.resume();await waitFor(()=>tunnel.stats.inboundResumes>previousResumes,5000);stalled.terminate();await once(stalled,'close');await waitFor(()=>tunnel.clients.size===0);
  const text=await openSocket(wsClient(port,cert));text.send('not binary');await once(text,'close');await waitFor(()=>tunnel.clients.size===0);
  const oversize=await openSocket(wsClient(port,cert));oversize.send(Buffer.alloc(MAX_FRAME+1));await once(oversize,'close');await waitFor(()=>tunnel.clients.size===0);
 }finally{await tunnel.close();await closeServer(echo);}
 assert.equal(tunnel.clients.size,0);
});

test('slow WSS receiver applies TCP backpressure and later resumes', {timeout:15000},async()=>{
 const upstream=createTcpServer(socket=>{
  socket.on('error',()=>{});let remaining=100;const chunk=Buffer.alloc(60*1024);
  function feed(){while(remaining>0){remaining--;if(!socket.write(chunk)){socket.once('drain',feed);return;}}}
  feed();
 });const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1);const port=await listen(tunnel.server);
 try{
  const ws=await openSocket(wsClient(port,cert));const reader=createWebSocketStream(ws,{highWaterMark:1024});reader.on('error',()=>{});reader.pause();
  await waitFor(()=>tunnel.stats.outboundPauses>0,5000);const previous=tunnel.stats.outboundResumes;
  reader.resume();await waitFor(()=>tunnel.stats.outboundResumes>previous,5000);reader.destroy();await waitFor(()=>tunnel.clients.size===0);
 }finally{await tunnel.close();await closeServer(upstream);}
});

test('idle timeout closes both endpoints', {timeout:5000},async()=>{
 let upstreamClosed=false;
 const upstream=createTcpServer(socket=>{socket.on('close',()=>{upstreamClosed=true;});socket.on('error',()=>{});socket.resume();});const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1,150);const port=await listen(tunnel.server);
 try{const ws=await openSocket(wsClient(port,cert));await once(ws,'close');await waitFor(()=>upstreamClosed&&tunnel.clients.size===0);}
 finally{await tunnel.close();await closeServer(upstream);}
});

test('prototype is disabled in production or without the explicit fixture flag',()=>{
 const before=process.env.NODE_ENV,flag=process.env.VIDEOMAKER_TURN_WSS_FIXTURE;
 try{
  process.env.NODE_ENV='production';assert.throws(()=>createBoundedFixtureServer(WebSocketServer),/FIXTURE_DISABLED/);
  process.env.NODE_ENV='test';delete process.env.VIDEOMAKER_TURN_WSS_FIXTURE;assert.throws(()=>bridgeTestOnly({}),/FIXTURE_DISABLED/);
 }finally{process.env.NODE_ENV=before;process.env.VIDEOMAKER_TURN_WSS_FIXTURE=flag;}
});

test('already closed or failed endpoints are rejected before a bridge is returned',()=>{
 const healthyWs={readyState:1},closedWs={readyState:3};
 const openTcp={connecting:false,destroyed:false,remoteAddress:'127.0.0.1'},closedTcp={...openTcp,destroyed:true};
 assert.throws(()=>bridgeTestOnly({websocket:closedWs,upstream:openTcp,createWebSocketStream}),/INVALID_FIXTURE_ENDPOINT/);
 assert.throws(()=>bridgeTestOnly({websocket:healthyWs,upstream:closedTcp,createWebSocketStream}),/INVALID_FIXTURE_ENDPOINT/);
});

test('already aborted signal closes both newly connected endpoints', {timeout:5000},async()=>{
 let upstreamClosed=false;
 const upstream=createTcpServer(socket=>{socket.on('close',()=>{upstreamClosed=true;});socket.on('error',()=>{});socket.resume();});const upstreamPort=await listen(upstream);
 const controller=new AbortController();controller.abort();const tunnel=startTunnel(key,cert,upstreamPort,1,5000,controller.signal);const port=await listen(tunnel.server);
 try{
  const ws=wsClient(port,cert);ws.on('error',()=>{});const closed=once(ws,'close');await closed;await waitFor(()=>tunnel.allHandles.length===1);
  assert.equal(await tunnel.allHandles[0].closed,'aborted');await waitFor(()=>upstreamClosed&&tunnel.clients.size===0&&tunnel.handles.size===0);
 }finally{await tunnel.close();await closeServer(upstream);}
});

test('abort closes the WebSocket and TCP endpoints and resolves the shutdown', {timeout:5000},async()=>{
 let upstreamClosed=false;
 const upstream=createTcpServer(socket=>{socket.on('close',()=>{upstreamClosed=true;});socket.on('error',()=>{});socket.resume();});const upstreamPort=await listen(upstream);
 const controller=new AbortController();const tunnel=startTunnel(key,cert,upstreamPort,1,5000,controller.signal);const port=await listen(tunnel.server);
 try{
  const ws=await openSocket(wsClient(port,cert));await waitFor(()=>tunnel.handles.size===1);const handle=[...tunnel.handles][0];const closed=once(ws,'close');controller.abort();
  await closed;assert.equal(await handle.closed,'aborted');await waitFor(()=>upstreamClosed&&tunnel.clients.size===0&&tunnel.handles.size===0);
 }finally{await tunnel.close();await closeServer(upstream);}
});

test('text frames never reach the TCP peer', {timeout:5000},async()=>{
 let received=0;
 const upstream=createTcpServer(socket=>{socket.on('data',chunk=>{received+=chunk.length;});socket.on('error',()=>{});});const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1);const port=await listen(tunnel.server);
 try{const ws=await openSocket(wsClient(port,cert));const closed=once(ws,'close');ws.send('must not reach TCP');await closed;await waitFor(()=>tunnel.clients.size===0);assert.equal(received,0);}
 finally{await tunnel.close();await closeServer(upstream);}
});

test('abrupt TCP peer loss terminates the WebSocket and resolves shutdown', {timeout:5000},async()=>{
 const upstream=createTcpServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.destroy());});const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1);const port=await listen(tunnel.server);
 try{
  const ws=await openSocket(wsClient(port,cert));await waitFor(()=>tunnel.handles.size===1);const handle=[...tunnel.handles][0];const closed=once(ws,'close');ws.send(Buffer.from([1]),{binary:true});
  await closed;assert.match(await handle.closed,/^tcp-(ended|closed|error)$/);await waitFor(()=>tunnel.clients.size===0&&tunnel.handles.size===0);
 }finally{await tunnel.close();await closeServer(upstream);}
});

test('absolute lifetime terminates a tunnel even with ongoing traffic', {timeout:5000},async()=>{
 const upstream=createTcpServer(socket=>{socket.on('error',()=>{});socket.on('data',chunk=>socket.write(chunk));});const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1,150,undefined,500);const port=await listen(tunnel.server);
 let timer;
 try{
  const ws=await openSocket(wsClient(port,cert));ws.on('message',()=>{});await waitFor(()=>tunnel.handles.size===1);const handle=[...tunnel.handles][0];const closed=once(ws,'close');
  timer=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(Buffer.from([1]),{binary:true});},40);
  await closed;assert.equal(await handle.closed,'lifetime');await waitFor(()=>tunnel.clients.size===0);
 }finally{clearInterval(timer);await tunnel.close();await closeServer(upstream);}
});

test('total byte budget terminates the tunnel', {timeout:15000},async()=>{
 const upstream=createTcpServer(socket=>{socket.on('error',()=>{});socket.resume();});const upstreamPort=await listen(upstream);
 const tunnel=startTunnel(key,cert,upstreamPort,1);const port=await listen(tunnel.server);
 try{
  const ws=await openSocket(wsClient(port,cert));const closed=once(ws,'close');const chunk=Buffer.alloc(MAX_FRAME);
  for(let i=0;i<130;i++)ws.send(chunk,{binary:true});
  await closed;await waitFor(()=>tunnel.stats.byteLimit===1);assert.equal(tunnel.stats.byteLimit,1);await waitFor(()=>tunnel.clients.size===0);
 }finally{await tunnel.close();await closeServer(upstream);}
});

test('real coturn clients exchange data over WSS and TCP', {timeout:35000},async()=>{
 const secret=randomBytes(32).toString('base64url');const credentials=issueTurnRestCredential(Buffer.from(secret),Math.floor(Date.now()/1000),300);
 const reserve=createTcpServer();const turnPort=await listen(reserve);await closeServer(reserve);
 const config=join(temp,'turn.conf');writeFileSync(config,[
  'listening-ip=127.0.0.1','relay-ip=127.0.0.1',`listening-port=${turnPort}`,'min-port=62000','max-port=62031',
  'realm=videomaker-fixture.invalid','use-auth-secret',`static-auth-secret=${secret}`,'no-tls','no-dtls','no-udp','no-cli','no-tcp-relay','no-multicast-peers','allow-loopback-peers','user-quota=8','total-quota=8','relay-threads=1','no-stdout-log',`log-file=${join(temp,'turn.log')}`,
 ].join('\n')+'\n',{mode:0o600});
 const turn=spawn('turnserver',['-c',config],{stdio:'ignore'});let tunnel,proxy;
 try{
  let ready=false;for(let i=0;i<40&&!ready;i++){
   if(turn.exitCode!==null)throw Error('coturn fixture exited');
   ready=await new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port:turnPort});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});if(!ready)await delay(100);
  }
  assert.equal(ready,true);
  tunnel=startTunnel(key,cert,turnPort);const tunnelPort=await listen(tunnel.server);proxy=localProxy(tunnelPort,cert);const proxyPort=await listen(proxy.server);
  const client=spawn('turnutils_uclient',['-t','-y','-c','-n','2','-p',String(proxyPort),'-u',credentials.username,'-w',credentials.credential,'127.0.0.1'],{stdio:['ignore','pipe','pipe']});
  let output='';client.stdout.on('data',chunk=>{output+=chunk;});client.stderr.on('data',chunk=>{output+=chunk;});
  const [status]=await once(client,'exit');assert.equal(status,0,'coturn fixture client failed; output withheld');assert.match(output,/Total lost packets 0/);
  await waitFor(()=>tunnel.clients.size===0);
 }finally{
  if(proxy)await proxy.close();if(tunnel)await tunnel.close();turn.kill('SIGTERM');if(turn.exitCode===null)await once(turn,'exit');
 }
});
