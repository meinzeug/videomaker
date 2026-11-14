import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

/** Internal building block only: the relay never decrypts or interprets messages. */
export class RendezvousError extends Error {
 readonly code:'INVALID'|'MISSING'|'DENIED'|'EXPIRED'|'CAPACITY'|'RATE'|'SEQUENCE';
 constructor(code:'INVALID'|'MISSING'|'DENIED'|'EXPIRED'|'CAPACITY'|'RATE'|'SEQUENCE'){super(code);this.code=code;}
}
type Role='owner'|'guest';
type Actor={role:'owner';owner:string}|{role:'guest';credential:string};
type Message={sequence:number;ciphertext:Buffer};
type Direction={next:number;lastHash:Buffer|null;acked:number;messages:Message[];times:number[]};
type Room={id:string;owner:string;ticketHash:Buffer;guestHash:Buffer|null;created:number;lastSeen:number;joinUntil:number;expires:number;toOwner:Direction;toGuest:Direction};
type Config={maxRooms:number;maxPerOwner:number;joinMs:number;roomMs:number;maxMessages:number;maxBytes:number;maxMessageBytes:number;maxRate:number;rateWindowMs:number};
const defaults:Config={maxRooms:64,maxPerOwner:2,joinMs:60_000,roomMs:30*60_000,maxMessages:16,maxBytes:256*1024,maxMessageBytes:32*1024,maxRate:60,rateWindowMs:10_000};
const fail=(code:RendezvousError['code']):never=>{throw new RendezvousError(code);};
const digest=(text:string|Uint8Array)=>createHash('sha256').update(text).digest();
const validSecret=(value:string)=>/^[A-Za-z0-9_-]{43}$/.test(value);
const equal=(left:Buffer,right:Buffer)=>left.length===right.length&&timingSafeEqual(left,right);
const direction=():Direction=>({next:1,lastHash:null,acked:0,messages:[],times:[]});

/**
 * Bounded, process-local, opaque room state. Its caller must authenticate every
 * owner request and invoke revokeOwner on logout; it is not an HTTP endpoint.
 * Restart deliberately closes all rooms and requires a fresh QR handshake.
 */
export class OpaqueRendezvous {
 private readonly rooms=new Map<string,Room>();
 private readonly config:Config;
 private readonly now:()=>number;
 constructor(now:()=>number=()=>Math.floor(performance.now()),config:Partial<Config>={}){
  this.now=now;this.config={...defaults,...config};
  for(const value of Object.values(this.config))if(!Number.isSafeInteger(value)||value<=0)fail('INVALID');
  if(this.config.joinMs>this.config.roomMs||this.config.maxMessageBytes>this.config.maxBytes)fail('INVALID');
 }
 private time(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)fail('INVALID');return value;}
 private prune(time:number){for(const [id,room] of this.rooms)if(time<room.lastSeen||time>=room.expires)this.rooms.delete(id);}
 private room(id:string,time:number){this.prune(time);if(!/^[A-Za-z0-9_-]{22}$/.test(id))return fail('INVALID');const room=this.rooms.get(id)??fail('MISSING');room.lastSeen=time;return room;}
 private authenticate(room:Room,actor:Actor){
  if(actor.role==='owner'){if(!/^[a-f0-9]{64}$/.test(actor.owner)||actor.owner!==room.owner)fail('DENIED');return;}
  if(actor.role!=='guest'||!validSecret(actor.credential)||!room.guestHash||!equal(digest(actor.credential),room.guestHash))fail('DENIED');
 }
 create(owner:string){
  if(!/^[a-f0-9]{64}$/.test(owner))return fail('INVALID');const time=this.time();this.prune(time);
  if(this.rooms.size>=this.config.maxRooms||[...this.rooms.values()].filter(room=>room.owner===owner).length>=this.config.maxPerOwner)return fail('CAPACITY');
  if(time>Number.MAX_SAFE_INTEGER-this.config.roomMs)return fail('INVALID');
  const id=randomBytes(16).toString('base64url'),ticket=randomBytes(32).toString('base64url');
  if(this.rooms.has(id))return fail('CAPACITY');
  this.rooms.set(id,{id,owner,ticketHash:digest(ticket),guestHash:null,created:time,lastSeen:time,joinUntil:time+this.config.joinMs,expires:time+this.config.roomMs,toOwner:direction(),toGuest:direction()});
  return {roomId:id,joinTicket:ticket,joinExpiresInMs:this.config.joinMs};
 }
 /** A joining device supplies a fresh independent credential; exact lost-ACK retries are idempotent. */
 join(id:string,ticket:string,credential:string){
  if(!validSecret(ticket)||!validSecret(credential)||ticket===credential)return fail('DENIED');const time=this.time(),room=this.room(id,time);
  if(!equal(room.ticketHash,digest(ticket)))return fail('DENIED');const guest=digest(credential);
  if(room.guestHash){if(!equal(room.guestHash,guest))return fail('DENIED');return {joined:true,created:false};}
  if(time>=room.joinUntil)return fail('EXPIRED');room.guestHash=guest;return {joined:true,created:true};
 }
 send(id:string,actor:Actor,sequence:number,ciphertext:Uint8Array){
  const time=this.time(),room=this.room(id,time);this.authenticate(room,actor);
  if(!Number.isSafeInteger(sequence)||sequence<1||sequence>=Number.MAX_SAFE_INTEGER||!(ciphertext instanceof Uint8Array)||ciphertext.byteLength<1||ciphertext.byteLength>this.config.maxMessageBytes)return fail('INVALID');
  const queue=actor.role==='owner'?room.toGuest:room.toOwner,hash=digest(ciphertext);
  if(sequence===queue.next-1&&queue.lastHash&&equal(queue.lastHash,hash))return {sequence,created:false};
  if(sequence!==queue.next)return fail('SEQUENCE');
  queue.times=queue.times.filter(value=>value<=time&&value>time-this.config.rateWindowMs);
  if(queue.times.length>=this.config.maxRate)return fail('RATE');
  const size=[...room.toOwner.messages,...room.toGuest.messages].reduce((sum,message)=>sum+message.ciphertext.length,0);
  if(queue.messages.length>=this.config.maxMessages||size+ciphertext.byteLength>this.config.maxBytes)return fail('CAPACITY');
  queue.messages.push({sequence,ciphertext:Buffer.from(ciphertext)});queue.next++;queue.lastHash=hash;queue.times.push(time);
  return {sequence,created:true};
 }
 peek(id:string,actor:Actor){
  const room=this.room(id,this.time());this.authenticate(room,actor);
  const message=(actor.role==='owner'?room.toOwner:room.toGuest).messages[0];
  return message?{sequence:message.sequence,ciphertext:Buffer.from(message.ciphertext)}:null;
 }
 acknowledge(id:string,actor:Actor,sequence:number){
  const room=this.room(id,this.time());this.authenticate(room,actor);
  if(!Number.isSafeInteger(sequence)||sequence<1)return fail('INVALID');
  const queue=actor.role==='owner'?room.toOwner:room.toGuest;
  if(sequence<=queue.acked)return {acknowledged:true,created:false};
  if(queue.messages[0]?.sequence!==sequence)return fail('SEQUENCE');
  queue.messages.shift();queue.acked=sequence;return {acknowledged:true,created:true};
 }
 close(id:string,owner:string){const room=this.room(id,this.time());this.authenticate(room,{role:'owner',owner});this.rooms.delete(id);}
 revokeOwner(owner:string){if(!/^[a-f0-9]{64}$/.test(owner))return fail('INVALID');let removed=0;for(const [id,room] of this.rooms)if(room.owner===owner){this.rooms.delete(id);removed++;}return removed;}
}
