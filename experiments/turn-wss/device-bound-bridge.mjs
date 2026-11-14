import {bridgeTestOnly} from './bridge.mjs';
import {claimDeviceRelayFixture,checkDeviceRelayFixture} from '../device-auth/core.mjs';

// Isolated prototype. A process-local proof object must come directly from the
// verified GET /api/relay/connect request; no client-created identity is accepted.
// Polling and chunk checks cannot retract bytes already sent or fence other workers.
export function createDeviceBoundTurnFixture({db,identity,clock,pollMs=100}){
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_TURN_WSS_FIXTURE!=='1'||process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE!=='1')throw Error('DEVICE_TURN_FIXTURE_DISABLED');
 if(typeof clock!=='function'||!Number.isSafeInteger(pollMs)||pollMs<20||pollMs>5000)throw Error('INVALID_DEVICE_TURN_FIXTURE');
 if(!claimDeviceRelayFixture(db,identity,clock))throw Error('DEVICE_TURN_DENIED');
 let disposed=false,attached=false,checking=false,timer,handle;
 const abort=new AbortController();
 function recheck(){
  let valid=false;
  if(!disposed&&!checking){checking=true;try{valid=checkDeviceRelayFixture(db,identity,clock)===true;}catch{}finally{checking=false;}}
  if(!valid){disposed=true;abort.abort();if(timer)clearInterval(timer);}
  return valid;
 }
 if(!recheck())throw Error('DEVICE_TURN_DENIED');
 return Object.freeze({
  checkBeforeUpgrade:recheck,
  attach({websocket,upstream,createWebSocketStream,options={}}){
   if(attached||disposed||!recheck()){
    try{websocket?.terminate();}catch{}try{upstream?.destroy();}catch{}throw Error('DEVICE_TURN_DENIED');
   }
   attached=true;
   try{handle=bridgeTestOnly({websocket,upstream,createWebSocketStream,signal:abort.signal,authorize:recheck,maxBytes:options.maxBytes,idleMs:options.idleMs,lifetimeMs:options.lifetimeMs,highWaterMark:options.highWaterMark,onEvent:options.onEvent});}
   catch(error){disposed=true;abort.abort();try{websocket?.terminate();}catch{}try{upstream?.destroy();}catch{}throw error;}
   if(!disposed){timer=setInterval(recheck,pollMs);timer.unref?.();}
   void handle.closed.then(()=>{disposed=true;clearInterval(timer);});
   return handle;
  },
  recheckNow:recheck,
  close(){disposed=true;abort.abort();if(timer)clearInterval(timer);return handle?.closed??Promise.resolve('closed');},
 });
}
