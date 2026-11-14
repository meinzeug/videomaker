import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import type {CameraClock} from './camera-remote-store';

// Preview signaling is intentionally bounded and process-local: SDP/ICE and
// network addresses never enter SQLite. A restart or another worker sees no
// session and therefore fails closed. This prototype remains feature-gated.
export const PREVIEW_BROWSER_LEASE_MS=12000,PREVIEW_OFFER_MS=15000,PREVIEW_DEVICE_LEASE_MS=10000,PREVIEW_MAX_MS=2*60*60*1000;
const MAX_GLOBAL=8,MAX_EVENTS=66,MAX_TOTAL_BYTES=256*1024,MAX_SDP_BYTES=64*1024,MAX_ICE_BYTES=1024;
const CREATE_TOKEN_MS=15000,TOMBSTONE_MS=30000,MAX_TOMBSTONES=512;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const bytes=(value:string)=>Buffer.byteLength(value,'utf8');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export class CameraPreviewError extends Error {
 readonly code:'invalid'|'conflict'|'notfound'|'capacity';
 constructor(code:CameraPreviewError['code'],message:string){super(message);this.code=code;}
}
const invalid=():never=>{throw new CameraPreviewError('invalid','Ungültige Vorschau-Nachricht.');};
function validateClock(clock:CameraClock){if(!uuid.test(clock.runtimeId)||!Number.isSafeInteger(clock.wall)||clock.wall<0||!Number.isSafeInteger(clock.tick)||clock.tick<0||clock.wall>Number.MAX_SAFE_INTEGER-PREVIEW_MAX_MS||clock.tick>Number.MAX_SAFE_INTEGER-PREVIEW_MAX_MS)invalid();}
function hostAddress(value:string):boolean {
 const name=value.toLowerCase();if(/^[a-z0-9-]{1,63}\.local$/.test(name))return true;
 const type=isIP(value);
 if(type===4){const p=value.split('.').map(Number);return p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===169&&p[1]===254);}
 if(type===6){const head=parseInt(value.split(':')[0]||'0',16);return (head&0xfe00)===0xfc00||(head&0xffc0)===0xfe80;}
 return false;
}
export function validatePreviewCandidate(value:string):boolean {
 if(bytes(value)>MAX_ICE_BYTES||/[\r\n\x00-\x1f\x7f]/.test(value))return false;
 const parts=value.trim().split(/\s+/);
 if(parts.length<8||!/^candidate:[a-z0-9+/]{1,64}$/i.test(parts[0])||!/^\d+$/.test(parts[1])||!['udp','tcp'].includes(parts[2].toLowerCase())||!/^\d+$/.test(parts[3])||!hostAddress(parts[4])||!/^\d+$/.test(parts[5])||Number(parts[5])<1||Number(parts[5])>65535||parts[6].toLowerCase()!=='typ'||parts[7].toLowerCase()!=='host')return false;
 // Related addresses are not expected for host-only ICE; never allow external
 // targets to hide in candidate extensions.
 return !parts.slice(8).some(part=>['raddr','rport'].includes(part.toLowerCase()));
}
function validSdp(value:unknown,kind:'offer'|'answer'):value is string {
 if(typeof value!=='string'||bytes(value)>MAX_SDP_BYTES||!value.startsWith('v=0')||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))return false;
 const lines=value.split(/\r?\n/),media=lines.filter(line=>line.startsWith('m='));
 if(media.length!==1||!/^m=video\s/i.test(media[0])||lines.some(line=>/^a=(candidate|remote-candidates):/i.test(line)))return false;
 const directions=lines.filter(line=>/^a=(?:sendrecv|sendonly|recvonly|inactive)$/i.test(line));
 if(directions.length!==1||directions[0]!==`a=${kind==='offer'?'recvonly':'sendonly'}`)return false;
 // No direct routable addresses embedded in SDP: all endpoints go through the
 // separately validated host-only ICE candidate messages.
 if(lines.some(line=>/^c=/i.test(line)&&!/^c=IN IP4 0\.0\.0\.0$/i.test(line)&&!/^c=IN IP6 ::$/i.test(line)))return false;
 if(lines.some(line=>/^a=rtcp:/i.test(line)&&!/^a=rtcp:\d+ IN IP4 0\.0\.0\.0$/i.test(line)&&!/^a=rtcp:\d+$/i.test(line)))return false;
 return true;
}
type Kind='offer'|'answer'|'ice'|'ice_end'|'end';
export type PreviewEvent={id:string;kind:Kind;data:string;mid:string|null;mLineIndex:number|null};
type StampedEvent=PreviewEvent & {seq:number};
type Side='browser'|'device';
type PreviewSession={id:string;deviceId:string;browserOwner:string;offerHash:string;runtimeId:string;createdWall:number;createdTick:number;browserWall:number;browserTick:number;offerAck:boolean;browserDelivered:number;deviceDelivered:number;browserEvents:StampedEvent[];deviceEvents:StampedEvent[];totalBytes:number};
function parseEvent(value:unknown,side:Side):PreviewEvent {
 if(!object(value)||typeof value.id!=='string'||!uuid.test(value.id)||typeof value.kind!=='string'||!['answer','ice','ice_end','end'].includes(value.kind)||typeof value.data!=='string'||!(value.mid===null||typeof value.mid==='string')||!(value.mLineIndex===null||Number.isInteger(value.mLineIndex)))return invalid();
 const kind=value.kind as Kind,mid=value.mid as string|null,index=value.mLineIndex as number|null;
 if(side==='browser'&&kind==='answer')return invalid();
 if(mid!==null&&(bytes(mid)>64||/[\x00-\x1f\x7f]/.test(mid)))return invalid();
 if(index!==null&&(index<0||index>255))return invalid();
 if(kind==='answer'&&(!validSdp(value.data,'answer')||mid!==null||index!==null))return invalid();
 if(kind==='ice'&&(!validatePreviewCandidate(value.data)||(mid===null&&index===null)))return invalid();
 if((kind==='end'||kind==='ice_end')&&(value.data!==''||mid!==null||index!==null))return invalid();
 return {id:value.id,kind,data:value.data,mid,mLineIndex:index};
}
function parseEvents(value:unknown,side:Side):PreviewEvent[]{if(!Array.isArray(value)||value.length>16)return invalid();const result=value.map(event=>parseEvent(event,side));if(new Set(result.map(event=>event.id)).size!==result.length)return invalid();return result;}
function parseAfter(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)return invalid();return Number(value);}
function eventSize(event:PreviewEvent){return bytes(JSON.stringify(event));}
export class CameraPreviewStore {
 private readonly sessions=new Map<string,PreviewSession>();
 private readonly available=new Map<string,{runtimeId:string;wall:number;tick:number;draining:boolean}>();
 private readonly usedSessionIds=new Map<string,{runtimeId:string;wall:number;tick:number}>();
 private readonly tokenKey=randomBytes(32);
 private blockedUntil:{runtimeId:string;wall:number;tick:number}|null=null;
 private markUsed(owner:string,id:string,clock:CameraClock){
  const key=`${owner}:${id}`,previous=this.usedSessionIds.get(key);
  if(previous){this.usedSessionIds.set(key,{runtimeId:clock.runtimeId,wall:Math.max(previous.wall,clock.wall),tick:Math.max(previous.tick,clock.tick)});return;}
  if(this.usedSessionIds.size>=MAX_TOMBSTONES){this.blockedUntil={runtimeId:clock.runtimeId,wall:clock.wall,tick:clock.tick};return;}
  this.usedSessionIds.set(key,{runtimeId:clock.runtimeId,wall:clock.wall,tick:clock.tick});
 }
 private createToken(owner:string,clock:CameraClock){
  const message=`camera-preview-create/v1\0${clock.runtimeId}\0${owner}\0${clock.wall}\0${clock.tick}`;
  return `${clock.wall}.${clock.tick}.${createHmac('sha256',this.tokenKey).update(message).digest('base64url')}`;
 }
 private validToken(value:unknown,owner:string,clock:CameraClock){
  if(typeof value!=='string')return false;const match=/^(\d{1,16})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);if(!match)return false;
  const wall=Number(match[1]),tick=Number(match[2]);if(!Number.isSafeInteger(wall)||!Number.isSafeInteger(tick)||String(wall)!==match[1]||String(tick)!==match[2]||wall>clock.wall||tick>clock.tick||clock.wall-wall>=CREATE_TOKEN_MS||clock.tick-tick>=CREATE_TOKEN_MS)return false;
  const expected=this.createToken(owner,{runtimeId:clock.runtimeId,wall,tick});const a=Buffer.from(value),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
 }
 private remaining(s:PreviewSession,c:CameraClock){
  if(s.runtimeId!==c.runtimeId||c.wall<s.createdWall||c.tick<s.createdTick||c.wall<s.browserWall||c.tick<s.browserTick)return 0;
  const device=this.available.get(s.deviceId);if(!device||device.runtimeId!==c.runtimeId||c.wall<device.wall||c.tick<device.tick)return 0;
  return Math.min(PREVIEW_MAX_MS-(c.wall-s.createdWall),PREVIEW_MAX_MS-(c.tick-s.createdTick),PREVIEW_BROWSER_LEASE_MS-(c.wall-s.browserWall),PREVIEW_BROWSER_LEASE_MS-(c.tick-s.browserTick),PREVIEW_DEVICE_LEASE_MS-(c.wall-device.wall),PREVIEW_DEVICE_LEASE_MS-(c.tick-device.tick),s.offerAck?PREVIEW_MAX_MS:PREVIEW_OFFER_MS-(c.wall-s.createdWall),s.offerAck?PREVIEW_MAX_MS:PREVIEW_OFFER_MS-(c.tick-s.createdTick));
 }
 private dropSession(session:PreviewSession,clock:CameraClock){
  this.markUsed(session.browserOwner,session.id,clock);this.sessions.delete(session.id);
  const device=this.available.get(session.deviceId);
  if(device&&session.deviceDelivered>0)this.available.set(session.deviceId,{...device,draining:true});
 }
 private sweep(clock:CameraClock){
  validateClock(clock);
  for(const [id,used] of this.usedSessionIds)if(used.runtimeId!==clock.runtimeId||(clock.wall>=used.wall&&clock.tick>=used.tick&&clock.wall-used.wall>=TOMBSTONE_MS&&clock.tick-used.tick>=TOMBSTONE_MS))this.usedSessionIds.delete(id);
  if(this.blockedUntil&&(this.blockedUntil.runtimeId!==clock.runtimeId||(clock.wall>=this.blockedUntil.wall&&clock.tick>=this.blockedUntil.tick&&clock.wall-this.blockedUntil.wall>=TOMBSTONE_MS&&clock.tick-this.blockedUntil.tick>=TOMBSTONE_MS)))this.blockedUntil=null;
  for(const [id,d] of this.available)if(d.runtimeId!==clock.runtimeId||clock.wall<d.wall||clock.tick<d.tick||clock.wall-d.wall>=PREVIEW_DEVICE_LEASE_MS||clock.tick-d.tick>=PREVIEW_DEVICE_LEASE_MS)this.available.delete(id);
  for(const [id,s] of this.sessions)if(this.remaining(s,clock)<=0||!this.available.has(s.deviceId)){this.dropSession(s,clock);}
 }
 availableDevices(clock:CameraClock,browserOwner:string){this.sweep(clock);if(!/^[a-f0-9]{64}$/.test(browserOwner))return invalid();return {generation:clock.runtimeId,creationToken:this.createToken(browserOwner,clock),devices:[...this.available].map(([deviceId,state])=>({deviceId,available:!state.draining}))};}
 create(input:unknown,browserOwner:string,clock:CameraClock,deviceAvailable:boolean){
  this.sweep(clock);
  if(!object(input)||typeof input.generation!=='string'||!uuid.test(input.generation)||typeof input.sessionId!=='string'||!uuid.test(input.sessionId)||typeof input.deviceId!=='string'||!uuid.test(input.deviceId)||!validSdp(input.offer,'offer')||!/^[a-f0-9]{64}$/.test(browserOwner))return invalid();
  if(input.generation!==clock.runtimeId)throw new CameraPreviewError('conflict','Vorschau-Sitzung ist veraltet.');
  if(!this.validToken(input.creationToken,browserOwner,clock))throw new CameraPreviewError('conflict','Vorschau-Freigabe ist abgelaufen.');
  const offerHash=sha(input.offer),existing=this.sessions.get(input.sessionId);
  if(existing){if(existing.browserOwner!==browserOwner||existing.deviceId!==input.deviceId||existing.offerHash!==offerHash)throw new CameraPreviewError('conflict','Vorschau-Sitzung ist bereits anders belegt.');existing.browserWall=clock.wall;existing.browserTick=clock.tick;return {sessionId:existing.id,leaseRemainingMs:this.remaining(existing,clock),created:false};}
  if(this.usedSessionIds.has(`${browserOwner}:${input.sessionId}`))throw new CameraPreviewError('conflict','Vorschau-Sitzung wurde bereits beendet.');
  if(!deviceAvailable||!this.available.has(input.deviceId)||this.available.get(input.deviceId)?.draining)throw new CameraPreviewError('conflict','Kamera hat die Vorschau nicht freigegeben oder ist nicht erreichbar.');
  if([...this.sessions.values()].some(session=>session.deviceId===input.deviceId))throw new CameraPreviewError('conflict','Für diese Kamera läuft bereits eine Vorschau.');
  if(this.sessions.size>=MAX_GLOBAL)throw new CameraPreviewError('capacity','Zu viele Vorschauen gleichzeitig.');
  if(this.blockedUntil||this.usedSessionIds.size>=MAX_TOMBSTONES)throw new CameraPreviewError('capacity','Vorschau-Sitzungslimit erreicht; bitte später erneut versuchen.');
  const offer:StampedEvent={id:input.sessionId,seq:1,kind:'offer',data:input.offer,mid:null,mLineIndex:null};
  const session:PreviewSession={id:input.sessionId,deviceId:input.deviceId,browserOwner,offerHash,runtimeId:clock.runtimeId,createdWall:clock.wall,createdTick:clock.tick,browserWall:clock.wall,browserTick:clock.tick,offerAck:false,browserDelivered:0,deviceDelivered:0,browserEvents:[offer],deviceEvents:[],totalBytes:eventSize(offer)};
  this.sessions.set(session.id,session);this.markUsed(browserOwner,session.id,clock);return {sessionId:session.id,leaseRemainingMs:this.remaining(session,clock),created:true};
 }
 private append(s:PreviewSession,side:Side,events:PreviewEvent[],after:number){
  const target=side==='browser'?s.browserEvents:s.deviceEvents,other=side==='browser'?s.deviceEvents:s.browserEvents;
  // Build the full change first, so invalid mixed batches cannot partially commit.
  const next=[...target];let total=s.totalBytes;
  for(const item of events){
   const prior=next.find(value=>value.id===item.id);
   if(prior){const {seq:_,...withoutSeq}=prior;if(JSON.stringify(withoutSeq)!==JSON.stringify(item))throw new CameraPreviewError('conflict','Nachrichten-ID wurde anders verwendet.');continue;}
   if(next.length>=MAX_EVENTS)throw new CameraPreviewError('capacity','Vorschau-Nachrichtenlimit erreicht.');
   if(item.kind==='ice'&&next.filter(event=>event.kind==='ice').length>=64)throw new CameraPreviewError('capacity','Zu viele ICE-Kandidaten.');
   if(side==='device'&&item.kind==='answer'&&(after<1||next.some(event=>event.kind==='answer')))throw new CameraPreviewError('conflict','Unerwartete Vorschau-Antwort.');
   if(side==='device'&&['ice','ice_end'].includes(item.kind)&&!next.some(event=>event.kind==='answer'))throw new CameraPreviewError('conflict','Antwort fehlt vor ICE-Kandidaten.');
   if(next.some(event=>event.kind==='end'))throw new CameraPreviewError('conflict','Vorschau wurde beendet.');
   const stamped={...item,seq:(next.at(-1)?.seq??0)+1};total+=eventSize(stamped);if(total>MAX_TOTAL_BYTES)throw new CameraPreviewError('capacity','Vorschau-Puffer voll.');
   next.push(stamped);
  }
  if(side==='browser')s.browserEvents=next;else s.deviceEvents=next;s.totalBytes=total;
  return other;
 }
 browserExchange(id:string,browserOwner:string,input:unknown,clock:CameraClock){
  this.sweep(clock);const s=this.sessions.get(id);if(!s||s.browserOwner!==browserOwner)throw new CameraPreviewError('notfound','Vorschau nicht gefunden.');
  if(!object(input))return invalid();const after=parseAfter(input.after),events=parseEvents(input.events,'browser');
  if(after>s.browserDelivered)throw new CameraPreviewError('conflict','Ungültige Vorschau-Bestätigung.');
  const other=this.append(s,'browser',events,after);s.browserWall=clock.wall;s.browserTick=clock.tick;
  const outgoing=other.filter(event=>event.seq>after);s.browserDelivered=Math.max(s.browserDelivered,outgoing.at(-1)?.seq??0);
  return {sessionId:s.id,leaseRemainingMs:this.remaining(s,clock),events:outgoing};
 }
 deviceExchange(deviceId:string,input:unknown,clock:CameraClock){
  this.sweep(clock);if(!uuid.test(deviceId)||!object(input)||typeof input.available!=='boolean'||(input.sessionId!==null&&(typeof input.sessionId!=='string'||!uuid.test(input.sessionId))))return invalid();
  const after=parseAfter(input.after),events=parseEvents(input.events,'device');
  if(!input.available){if(events.length)return invalid();this.available.delete(deviceId);for(const [id,value] of this.sessions)if(value.deviceId===deviceId){this.markUsed(value.browserOwner,id,clock);this.sessions.delete(id);}return {session:null};}
  if(!this.available.has(deviceId)&&this.available.size>=64)throw new CameraPreviewError('capacity','Zu viele verfügbare Kameras.');
  const s=[...this.sessions.values()].find(session=>session.deviceId===deviceId);
  if(!s){
   // A poll naming an old session makes the device close its peer. Only its
   // later idle poll proves that the close callback has completed.
   if(input.sessionId===null&&(after!==0||events.length))return invalid();
   this.available.set(deviceId,{runtimeId:clock.runtimeId,wall:clock.wall,tick:clock.tick,draining:input.sessionId!==null});return {session:null};
  }
  if(input.sessionId!==null&&input.sessionId!==s.id)throw new CameraPreviewError('conflict','Vorschau-Sitzung ist veraltet.');
  if(input.sessionId===null&&(after!==0||events.length))return invalid();
  if(after>s.deviceDelivered)throw new CameraPreviewError('conflict','Ungültige Vorschau-Bestätigung.');
  const other=this.append(s,'device',events,after);this.available.set(deviceId,{runtimeId:clock.runtimeId,wall:clock.wall,tick:clock.tick,draining:false});if(after>=1)s.offerAck=true;
  const outgoing=other.filter(event=>event.seq>after);s.deviceDelivered=Math.max(s.deviceDelivered,outgoing.at(-1)?.seq??0);
  return {session:{sessionId:s.id,deviceId:s.deviceId,leaseRemainingMs:this.remaining(s,clock),events:outgoing}};
 }
 close(id:string,browserOwner:string,clock:CameraClock){this.sweep(clock);if(!uuid.test(id)||!/^[a-f0-9]{64}$/.test(browserOwner))return invalid();this.markUsed(browserOwner,id,clock);const s=this.sessions.get(id);if(s&&s.browserOwner===browserOwner)this.dropSession(s,clock);return {closed:true};}
}
declare global {var __cameraPreviewStore:CameraPreviewStore|undefined;}
export function cameraPreviewStore(){return globalThis.__cameraPreviewStore??=new CameraPreviewStore();}
/** Fail closed if a surrounding database transaction cannot commit. */
export function resetCameraPreviewStore(){globalThis.__cameraPreviewStore=new CameraPreviewStore();}
