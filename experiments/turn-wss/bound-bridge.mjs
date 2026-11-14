import {bridgeTestOnly} from './bridge.mjs';
import {resolveRelayBrowserSession} from '../../lib/relay-browser-sessions.ts';
import {verifyRelayPeerBinding} from '../../lib/relay-session-authorization.ts';

const HASH=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requireFixture=()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_TURN_WSS_FIXTURE!=='1')throw Error('TURN_WSS_FIXTURE_DISABLED');
};

/**
 * Test-only authorization for one immutable owner/session/device/pair/room/role.
 * `authenticatedPrincipal` is a trusted server callback, never client JSON.
 * Its device identity MUST eventually come from an independently verified key proof.
 * The current resolver uses browser-session fixtures and is not Android device login.
 * No HTTP listener, upgrade route, production toggle or cross-process revocation bus is provided.
 */
export function createBoundTurnFixture({db,secret,owner,session,request,credential,clock,wallClock,authenticatedPrincipal,pollMs=100}){
 requireFixture();
 if(!db||typeof secret!=='string'||secret.length<32||!HASH.test(owner)||!HASH.test(session)||
    !request||!UUID.test(request.deviceId)||!UUID.test(request.pairId)||!['camera','prompter'].includes(request.role)||
    typeof request.roomId!=='string'||typeof request.tokenHash!=='string'||typeof credential!=='string'||
    typeof clock!=='function'||typeof wallClock!=='function'||typeof authenticatedPrincipal!=='function'||
    !Number.isSafeInteger(pollMs)||pollMs<20||pollMs>5000)throw Error('INVALID_BOUND_FIXTURE');
 const fixed=Object.freeze({pairId:request.pairId,deviceId:request.deviceId,role:request.role,roomId:request.roomId,tokenHash:request.tokenHash});
 const participant=Object.freeze({session,request:fixed,credential,
  authorize:()=>resolveRelayBrowserSession(db,secret,owner,session,wallClock)});
 let disposed=false,attached=false,checking=false,timer,handle;
 const abort=new AbortController();
 function allowed(){
  if(disposed||checking)return false;
  checking=true;
  try{
   const principal=authenticatedPrincipal();
   if(!principal||principal.owner!==owner||principal.session!==session||principal.deviceId!==fixed.deviceId)return false;
   return verifyRelayPeerBinding(db,owner,participant,clock,
    peer=>resolveRelayBrowserSession(db,secret,owner,peer,wallClock))===true;
  }catch{return false;}
  finally{checking=false;}
 }
 function recheck(){
  const valid=allowed();
  if(!valid){disposed=true;abort.abort();if(timer)clearInterval(timer);}
  return valid;
 }
 // A caller must execute this before upgrade. attach() rechecks after upgrade.
 if(!recheck())throw Error('TURN_BOUND_DENIED');
 return Object.freeze({
  checkBeforeUpgrade:recheck,
  attach({websocket,upstream,createWebSocketStream,options={}}){
   if(attached||disposed||!recheck()){
    try{websocket?.terminate();}catch{}
    try{upstream?.destroy();}catch{}
    throw Error('TURN_BOUND_DENIED');
   }
   attached=true;
   try{
    handle=bridgeTestOnly({websocket,upstream,createWebSocketStream,signal:abort.signal,authorize:recheck,
     maxBytes:options.maxBytes,idleMs:options.idleMs,lifetimeMs:options.lifetimeMs,highWaterMark:options.highWaterMark,onEvent:options.onEvent});
   }catch(error){disposed=true;abort.abort();try{websocket?.terminate();}catch{}try{upstream?.destroy();}catch{}throw error;}
   if(!disposed){timer=setInterval(recheck,pollMs);timer.unref?.();}
   void handle.closed.then(()=>{disposed=true;clearInterval(timer);});
   return handle;
  },
  // A local revocation handler should invoke this after its transaction commits.
  // Polling closes idle sockets if an external writer changed the database; it is
  // not an instantaneous cross-process fence or a recall of already sent bytes.
  recheckNow:recheck,
  close(){disposed=true;abort.abort();if(timer)clearInterval(timer);return handle?.closed??Promise.resolve('closed');},
 });
}
