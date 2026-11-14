import {Transform} from 'node:stream';

// Isolated experiment only. No endpoint, device authorizer, or production enablement exists here.
export const FRAME_BYTES=64*1024;
const ABSOLUTE_BYTES=16*1024*1024,ABSOLUTE_LIFETIME_MS=60_000;
const requireFixture=()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_TURN_WSS_FIXTURE!=='1')throw Error('TURN_WSS_FIXTURE_DISABLED');
};

/** A no-server WebSocket instance with a hard frame limit and compression disabled. */
export function createBoundedFixtureServer(WebSocketServer){
 requireFixture();
 if(typeof WebSocketServer!=='function')throw Error('INVALID_WEBSOCKET_SERVER');
 return new WebSocketServer({noServer:true,maxPayload:FRAME_BYTES,perMessageDeflate:false});
}

/**
 * Bridge an already authenticated WSS connection to an already connected loopback TCP socket.
 * The caller MUST have independently verified the current device/pair/session and configured
 * the WebSocket server/client with maxPayload <= FRAME_BYTES and compression disabled BEFORE
 * receiving any frames. This function deliberately refuses to run outside an explicit test.
 */
export function bridgeTestOnly({websocket,upstream,createWebSocketStream,authorize,signal,
 maxBytes=8*1024*1024,idleMs=5000,lifetimeMs=15000,highWaterMark=16*1024,onEvent=()=>{}}){
 requireFixture();
 if(!websocket||websocket.readyState!==1||!upstream||upstream.connecting||upstream.destroyed||
    !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(upstream.remoteAddress)||typeof createWebSocketStream!=='function'||typeof authorize!=='function')throw Error('INVALID_FIXTURE_ENDPOINT');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>ABSOLUTE_BYTES||
    !Number.isSafeInteger(idleMs)||idleMs<10||idleMs>ABSOLUTE_LIFETIME_MS||
    !Number.isSafeInteger(lifetimeMs)||lifetimeMs<idleMs||lifetimeMs>ABSOLUTE_LIFETIME_MS||
    !Number.isSafeInteger(highWaterMark)||highWaterMark<1024||highWaterMark>FRAME_BYTES||typeof onEvent!=='function')throw Error('INVALID_FIXTURE_LIMIT');
 if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw Error('INVALID_FIXTURE_SIGNAL');
 let done=false,wsClosed=false,tcpClosed=false,idleTimer,lifeTimer,reason='';
 let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});
 const emit=(type)=>{try{onEvent(type);}catch{/* Observability never affects transport. */}};
 const maybeClosed=()=>{if(wsClosed&&tcpClosed)resolveClosed(reason);};
 let stream,inbound,outbound;
 const finish=(why)=>{
  if(done)return;done=true;reason=why;clearTimeout(idleTimer);clearTimeout(lifeTimer);
  if(signal)signal.removeEventListener('abort',aborted);
  inbound?.destroy();outbound?.destroy();stream?.destroy();upstream.destroy();
  if(websocket.readyState!==3)websocket.terminate();
  if(websocket.readyState===3)wsClosed=true;
  maybeClosed();
 };
 const aborted=()=>finish('aborted');
 const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>finish('idle'),idleMs);};
 function limiter(direction){
  let total=0;
  return new Transform({highWaterMark,transform(chunk,_encoding,callback){
   if(done){callback();return;}
   if(chunk.length>FRAME_BYTES){callback();finish(direction+'-frame-limit');return;}
   total+=chunk.length;
   if(total>maxBytes){callback();finish(direction+'-limit');return;}
   let allowed=false;try{allowed=authorize(direction)===true;}catch{/* Authorization errors fail closed. */}
   if(!allowed){callback();finish('unauthorized');return;}
   touch();callback(null,chunk);
  }});
 }
 // Register before createWebSocketStream: terminate before a non-binary frame can be forwarded.
 const validate=(data,isBinary)=>{
  if(!isBinary){finish('text-frame');return;}
  const length=Array.isArray(data)?data.reduce((sum,value)=>sum+value.byteLength,0):data?.byteLength;
  if(!Number.isSafeInteger(length)||length<0||length>FRAME_BYTES)finish('frame-limit');
 };
 websocket.on('message',validate);
 websocket.on('error',()=>finish('websocket-error'));
 websocket.on('close',()=>{wsClosed=true;finish('websocket-closed');maybeClosed();});
 upstream.on('error',()=>finish('tcp-error'));
 upstream.on('end',()=>finish('tcp-ended'));
 upstream.on('close',()=>{tcpClosed=true;finish('tcp-closed');maybeClosed();});
 if(signal){signal.addEventListener('abort',aborted,{once:true});if(signal.aborted){finish('aborted');return {closed,stop:()=>finish('stopped')};}}
 stream=createWebSocketStream(websocket,{highWaterMark});inbound=limiter('inbound');outbound=limiter('outbound');
 for(const channel of [stream,inbound,outbound])channel.on('error',()=>finish('stream-error'));
 stream.on('pause',()=>emit('websocket-backpressure'));stream.on('resume',()=>emit('websocket-resumed'));
 upstream.on('pause',()=>emit('tcp-backpressure'));upstream.on('resume',()=>emit('tcp-resumed'));
 stream.pipe(inbound).pipe(upstream);upstream.pipe(outbound).pipe(stream);
 lifeTimer=setTimeout(()=>finish('lifetime'),lifetimeMs);touch();
 return {closed,stop:()=>finish('stopped')};
}
