import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {initializeStudioRateFixture,admitStudioRateFixture} from './rate-limit.mjs';
import {createStudioRoomFixture,joinStudioRoomFixture,approveStudioRoomFixture,studioPairingKeyFixture,sendStudioFrameFixture,peekStudioFrameFixture,acknowledgeStudioFrameFixture,closeStudioRoomFixture} from './core.mjs';

// Local test harness only. Never bind this to a public address or adapt it as-is to production.
const ORIGIN='https://videomaker.dorfspy.de',MAX_BODY=24576,MAX_BODY_MS=5000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const response=(res,status,body)=>{if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','content-length':bytes.length,'x-content-type-options':'nosniff'});res.end(bytes);};
function body(req){return new Promise((resolve,reject)=>{
 let size=0,done=false,chunks=[];const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);if(err)reject(err);else resolve(value);};
 const onData=part=>{size+=part.length;if(size>MAX_BODY){finish(Error('body'));req.destroy();return;}chunks.push(part);};
 const onEnd=()=>{try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error();finish(null,parsed);}catch{finish(Error('body'));}};
 const onError=()=>finish(Error('body'));const timer=setTimeout(()=>{finish(Error('timeout'));req.destroy();},MAX_BODY_MS);req.on('data',onData);req.on('end',onEnd);req.on('error',onError);
 });}
function exact(input,required){const keys=Object.keys(input).sort(),expected=[...required].sort();return keys.length===expected.length&&keys.every((x,i)=>x===expected[i]);}
function frame(value){if(typeof value!=='string'||value.length>21848||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('invalid');const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>16384||bytes.toString('base64')!==value)throw Error('invalid');return bytes;}
/** getPrincipal and authorize must be supplied by the isolated test harness. */
export function createStudioRendezvousHttpFixture({db,getPrincipal,authorize,clock,serverSecret,ratePolicy}){
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE!=='1')throw Error('STUDIO_RENDEZVOUS_FIXTURE_DISABLED');
 if(typeof getPrincipal!=='function'||typeof authorize!=='function'||typeof clock!=='function'||!Buffer.isBuffer(serverSecret)||serverSecret.length<32)throw Error('INVALID_FIXTURE');
 initializeStudioRateFixture(db);
 const wake=new EventEmitter(),waiters=new Set();
 const trace=stage=>{if(process.env.VIDEOMAKER_STUDIO_FIXTURE_DIAGNOSTIC==='1')process.stderr.write('fixture guard: '+stage+'\n');};
 const poll=async(room,role,res,read)=>{
  const key=room+':'+role;if(waiters.has(key))throw Error('STUDIO_RENDEZVOUS_BACKPRESSURE');waiters.add(key);
  let finish;const pending=new Promise(resolve=>{let done=false;finish=()=>{if(done)return;done=true;clearTimeout(timer);wake.off(room,finish);res.off('close',finish);resolve();};const timer=setTimeout(finish,1000);wake.once(room,finish);res.once('close',finish);});
  try{let result=read();if(result.empty){await pending;if(res.destroyed)throw Error('closed');result=read();}return result;}finally{finish();waiters.delete(key);}
 };
 const server=createServer(async(req,res)=>{
  let admitted=false;try{admitted=admitStudioRateFixture(db,{ip:req.socket.remoteAddress},serverSecret,clock,ratePolicy);}catch{}
  if(!admitted){response(res,429,{error:'rate'});req.resume();return;}
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.method!=='POST'||req.headers.origin!==ORIGIN||req.headers['content-type']!=='application/json'){trace(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)?'peer':req.method!=='POST'?'method':req.headers.origin!==ORIGIN?'origin':'content-type');response(res,403,{error:'denied'});req.resume();return;}
  let principal;try{principal=getPrincipal(req);}catch{principal=null;}if(!principal){trace('principal');response(res,403,{error:'denied'});req.resume();return;}
  try{admitted=admitStudioRateFixture(db,{ip:req.socket.remoteAddress,ownerHash:principal.ownerHash,sessionHash:principal.sessionHash},serverSecret,clock,ratePolicy);}catch{admitted=false;}
  if(!admitted){response(res,429,{error:'rate'});req.resume();return;}
  let stage='body';try{
   const input=await body(req),url=req.url||'',base={ownerHash:principal.ownerHash,sessionHash:principal.sessionHash};let result;stage='route-or-core';
   if(url==='/fixture/rooms'&&exact(input,['deviceId','attemptId']))result=createStudioRoomFixture(db,{...base,deviceId:input.deviceId,attemptId:input.attemptId},serverSecret,clock,authorize);
   else if(url==='/fixture/rooms/join'&&exact(input,['roomId','deviceId','joinCode']))result=joinStudioRoomFixture(db,{...base,...input},clock,authorize);
   else{
    const match=/^\/fixture\/rooms\/([0-9a-f-]{36})\/(approve|key|send|peek|ack|close)$/.exec(url);if(!match||!UUID.test(match[1]))throw Error('denied');
    const operation=match[2],keys=operation==='send'?['deviceId','role','sequence','data']:operation==='ack'?['deviceId','role','sequence']:['deviceId','role'];if(!exact(input,keys))throw Error('denied');
    const member={...base,roomId:match[1],deviceId:input.deviceId,role:input.role};
    switch(operation){
     case 'approve':result=approveStudioRoomFixture(db,member,clock,authorize);break;
     case 'key':result=studioPairingKeyFixture(db,member,serverSecret,clock,authorize);break;
     case 'send':result=sendStudioFrameFixture(db,{...member,sequence:input.sequence,data:frame(input.data)},clock,authorize);wake.emit(member.roomId);break;
     case 'peek':result=await poll(member.roomId,member.role,res,()=>peekStudioFrameFixture(db,member,clock,authorize));if(result.data)result={sequence:result.sequence,data:result.data.toString('base64')};break;
     case 'ack':result=acknowledgeStudioFrameFixture(db,{...member,sequence:input.sequence},clock,authorize);break;
     case 'close':result=closeStudioRoomFixture(db,member,clock,authorize);wake.emit(member.roomId);break;
    }
   }
   response(res,200,result);
  }catch(error){trace(stage);if(error?.message==='STUDIO_RENDEZVOUS_BACKPRESSURE')response(res,429,{error:'backpressure'});else response(res,403,{error:'denied'});}
 });
 server.headersTimeout=6000;server.requestTimeout=6000;server.maxHeadersCount=32;
 // Guard both bind and peer address: this test server cannot listen publicly.
 const listen=server.listen.bind(server);server.listen=(port,host,...rest)=>{if(host!=='127.0.0.1'&&host!=='::1')throw Error('LOOPBACK_REQUIRED');return listen(port,host,...rest);};
 return server;
}
