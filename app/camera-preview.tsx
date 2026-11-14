'use client';
import {useEffect,useRef,useState} from 'react';
import {cameraLensChanged} from '@/lib/camera-preview-reconnect';

type SignalEvent={id:string;kind:'answer'|'ice'|'ice_end'|'end';data:string;mid:string|null;mLineIndex:number|null;seq?:number};
type Session={id:string;deviceId:string;generation:string;pc:RTCPeerConnection;pending:SignalEvent[];after:number;closed:boolean;timer:ReturnType<typeof setTimeout>|null;frameTimer:ReturnType<typeof setTimeout>|null;frameCheckTimer:ReturnType<typeof setTimeout>|null;deadline:number;abort:AbortController;iceCount:number;framesSeen:boolean;lastFrame:number};
type Phase='idle'|'connecting'|'live'|'error';

/** Only private host candidates; Next never receives media or public relay addresses. */
function localCandidate(value:string){
 const parts=value.trim().split(/\s+/);if(parts[6]?.toLowerCase()!=='typ'||parts[7]?.toLowerCase()!=='host')return false;
 const address=(parts[4]||'').toLowerCase();if(/^[a-z0-9-]{1,63}\.local$/.test(address))return true;
 if(address.includes(':'))return /^(?:f[cd]|fe[89ab])/i.test(address);
 const p=address.split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===169&&p[1]===254));
}

/** The separate peer never owns or stops the Android camera, recorder or phone peer. */
export default function CameraPreview({deviceId,available,generation,creationToken,cameraFront}:{deviceId:string;available:boolean;generation:string;creationToken:string;cameraFront:boolean|null}){
 const [phase,setPhase]=useState<Phase>('idle'),[message,setMessage]=useState('');
 const video=useRef<HTMLVideoElement>(null),current=useRef<Session|null>(null),mounted=useRef(true);
 const wanted=useRef(false),release=useRef<Promise<void>>(Promise.resolve()),lens=useRef<{deviceId:string;front:boolean|null}|null>(null);
 const pendingReconnect=useRef<{deviceId:string;generation:string;front:boolean;wait:Promise<void>}|null>(null);
 const config=useRef({deviceId,generation,available,cameraFront});config.current={deviceId,generation,available,cameraFront};
 function close(session:Session,reason?:string){
  if(session.closed)return;session.closed=true;session.abort.abort();if(session.timer)clearTimeout(session.timer);if(session.frameTimer)clearTimeout(session.frameTimer);if(session.frameCheckTimer)clearTimeout(session.frameCheckTimer);
  session.pc.onicecandidate=null;session.pc.ontrack=null;session.pc.onconnectionstatechange=null;session.pc.close();
  if(video.current)video.current.srcObject=null;
  if(current.current===session)current.current=null;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),3000);
  release.current=fetch(`/api/camera-preview/sessions/${encodeURIComponent(session.id)}`,{method:'DELETE',keepalive:true,signal:controller.signal}).then(()=>{}).catch(()=>{}).finally(()=>clearTimeout(timeout));
  if(mounted.current){setPhase(reason?'error':'idle');setMessage(reason||'');}
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;wanted.current=false;pendingReconnect.current=null;const session=current.current;if(session)close(session);};},[]);
 useEffect(()=>{const session=current.current;if(session&&(!available||session.deviceId!==deviceId||session.generation!==generation))close(session,'Die Kamerafreigabe ist nicht mehr verfügbar.');},[available,deviceId,generation]);
 useEffect(()=>{
  const next={deviceId,front:cameraFront};
  if(cameraLensChanged(lens.current,next)&&wanted.current&&typeof cameraFront==='boolean'){
   const session=current.current;if(session)close(session);
   pendingReconnect.current={deviceId,generation,front:cameraFront,wait:release.current};
   setPhase('connecting');setMessage('Livebild wird nach dem Kamerawechsel erneut verbunden …');
  }
  lens.current=next;
  if(pendingReconnect.current&&(pendingReconnect.current.deviceId!==deviceId||pendingReconnect.current.generation!==generation))pendingReconnect.current=null;
  const pending=pendingReconnect.current;if(!pending||!available)return;
  void pending.wait.then(()=>{
   const latest=config.current;
   if(!mounted.current||!wanted.current||pendingReconnect.current!==pending||!latest.available||latest.deviceId!==pending.deviceId||latest.generation!==pending.generation||latest.cameraFront!==pending.front)return;
   pendingReconnect.current=null;void start();
  });
 },[deviceId,generation,available,cameraFront]);
 async function start(){
  if(current.current||!available)return;
  if(!window.isSecureContext||typeof RTCPeerConnection==='undefined'){setPhase('error');setMessage('Livebild benötigt eine sichere Verbindung und WebRTC.');return;}
  const pc=new RTCPeerConnection({iceServers:[]});const session:Session={id:crypto.randomUUID(),deviceId,generation,pc,pending:[],after:0,closed:false,timer:null,frameTimer:null,frameCheckTimer:null,deadline:performance.now()+15000,abort:new AbortController(),iceCount:0,framesSeen:false,lastFrame:0};current.current=session;setPhase('connecting');setMessage('Vorschau wird verbunden …');
  function enqueue(event:Omit<SignalEvent,'id'>){if(session.closed)return;if(event.kind==='ice'&&++session.iceCount>64){close(session,'Zu viele lokale Netzwerkadressen für die Vorschau.');return;}session.pending.push({id:crypto.randomUUID(),...event});}
  pc.onicecandidate=event=>{if(event.candidate){if(localCandidate(event.candidate.candidate))enqueue({kind:'ice',data:event.candidate.candidate,mid:event.candidate.sdpMid,mLineIndex:event.candidate.sdpMLineIndex});}else enqueue({kind:'ice_end',data:'',mid:null,mLineIndex:null});};
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))close(session,'Die Livebild-Verbindung wurde unterbrochen.');};
  pc.ontrack=event=>{if(event.track.kind!=='video'||session.closed||!video.current)return;const element=video.current;element.srcObject=new MediaStream([event.track]);void element.play().catch(()=>close(session,'Das Livebild konnte nicht abgespielt werden.'));
   const received=()=>{session.lastFrame=performance.now();if(session.framesSeen)return;session.framesSeen=true;if(session.frameTimer)clearTimeout(session.frameTimer);if(!session.closed&&mounted.current){setPhase('live');setMessage('Livebild');}};
   const requestFrame=(element as unknown as {requestVideoFrameCallback?:(callback:()=>void)=>number}).requestVideoFrameCallback;
   if(typeof requestFrame==='function'){
    const next=()=>{if(session.closed)return;received();requestFrame.call(element,next);};requestFrame.call(element,next);
    const check=()=>{if(session.closed)return;if(session.framesSeen&&performance.now()-session.lastFrame>5000){close(session,'Das Livebild ist unterbrochen.');return;}session.frameCheckTimer=setTimeout(check,1000);};check();
   }else {let frames=0;const check=()=>{if(session.closed)return;const count=element.getVideoPlaybackQuality().totalVideoFrames;if(count>frames){frames=count;received();}if(session.framesSeen&&performance.now()-session.lastFrame>5000){close(session,'Das Livebild ist unterbrochen.');return;}session.frameCheckTimer=setTimeout(check,500);};check();}
  };
  session.frameTimer=setTimeout(()=>{if(!session.closed&&!session.framesSeen)close(session,'Das Livebild konnte nicht rechtzeitig verbunden werden.');},30000);
  async function request(url:string,body:unknown){
   if(session.closed||session.abort.signal.aborted)throw Error('Vorschau beendet.');
   const local=new AbortController(),stop=()=>local.abort();session.abort.signal.addEventListener('abort',stop,{once:true});const timeout=setTimeout(stop,3000);
   if(session.abort.signal.aborted)local.abort();
   try{return await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:local.signal});}
   finally{clearTimeout(timeout);session.abort.signal.removeEventListener('abort',stop);}
  }
  try{
   pc.addTransceiver('video',{direction:'recvonly'});const offer=await pc.createOffer();if(!offer.sdp)throw Error('Kein Vorschauangebot verfügbar.');await pc.setLocalDescription(offer);
   const createdAt=performance.now();let response:Response;
   try{response=await request('/api/camera-preview/sessions',{generation,creationToken,sessionId:session.id,deviceId,offer:offer.sdp});}
   catch{if(session.closed)throw Error('Vorschau beendet.');response=await request('/api/camera-preview/sessions',{generation,creationToken,sessionId:session.id,deviceId,offer:offer.sdp});}
   if(!response.ok)throw Error('Die Kamera hat die Vorschau nicht freigegeben oder ist nicht erreichbar.');const created=await response.json();const initialRemaining=Math.min(12000,Number(created.leaseRemainingMs)||0)-(performance.now()-createdAt);if(initialRemaining<=0)throw Error('Die Vorschau-Sitzung ist abgelaufen.');session.deadline=performance.now()+initialRemaining;
   async function exchange(){
    if(session.closed)return;if(performance.now()>=session.deadline){close(session,'Die Vorschau-Sitzung ist abgelaufen.');return;}
    const events=session.pending.slice(0,16),started=performance.now();
    try{
     const response=await request(`/api/camera-preview/sessions/${encodeURIComponent(session.id)}/exchange`,{after:session.after,events});
     if(response.status>=400&&response.status<500){close(session,'Die Vorschau wurde beendet oder ist nicht mehr freigegeben.');return;}
     if(!response.ok)throw Error('Vorschau-Signalisierung unterbrochen.');const data=await response.json();const remaining=Math.min(12000,Number(data.leaseRemainingMs)||0)-(performance.now()-started);if(remaining<=0)throw Error('Die Vorschau-Sitzung ist abgelaufen.');session.deadline=performance.now()+remaining;
     session.pending.splice(0,events.length);
     for(const event of data.events as SignalEvent[]){
      if(!Number.isSafeInteger(event.seq)||event.seq!==session.after+1)throw Error('Ungültige Vorschau-Reihenfolge.');
      if(event.kind==='answer')await pc.setRemoteDescription({type:'answer',sdp:event.data});
      else if(event.kind==='ice')await pc.addIceCandidate({candidate:event.data,sdpMid:event.mid,sdpMLineIndex:event.mLineIndex});
      else if(event.kind==='ice_end')await pc.addIceCandidate(null);
      else if(event.kind==='end'){close(session,'Die Kamera hat die Vorschau beendet.');return;}
      session.after=event.seq!;
     }
     session.timer=setTimeout(()=>void exchange(),2000);
    }catch(error){if(session.closed)return;if(performance.now()>=session.deadline){close(session,'Die Vorschau-Sitzung ist abgelaufen.');return;}session.timer=setTimeout(()=>void exchange(),Math.min(1000,Math.max(0,session.deadline-performance.now())));}
   }
   await exchange();
  }catch(error){close(session,error instanceof Error?error.message:'Die Vorschau konnte nicht gestartet werden.');}
 }
 return <div className="camera-preview"><div className="device-actions"><button type="button" className="secondary-action" disabled={!available||phase==='connecting'||phase==='live'} onClick={()=>{wanted.current=true;void start();}}>Livebild öffnen</button>{phase!=='idle'&&<button type="button" className="secondary-action" onClick={()=>{wanted.current=false;pendingReconnect.current=null;const s=current.current;if(s)close(s);else {setPhase('idle');setMessage('');}}}>Livebild schließen</button>}</div>{!available&&<p>Die Webvorschau muss am Kameragerät ausdrücklich freigegeben sein.</p>}{message&&<p role="status">{message}</p>}<video ref={video} muted playsInline autoPlay aria-label="Smartphone-Livebild" hidden={phase==='idle'||phase==='error'}/></div>;
}
