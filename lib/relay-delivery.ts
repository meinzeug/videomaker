import type Database from 'better-sqlite3';
import {OpaqueRendezvous,type RendezvousActor} from './opaque-rendezvous.ts';
import {resolveRelayBrowserSession} from './relay-browser-sessions.ts';
import {verifyRelayPeerBinding} from './relay-session-authorization.ts';

type Participant=Parameters<typeof verifyRelayPeerBinding>[2];
type Clock=Parameters<typeof verifyRelayPeerBinding>[3];

/**
 * Internal single-process building block, not an HTTP route. Authenticated
 * callers must derive `owner` and participant session from server credentials.
 * Queue changes and both session checks run synchronously under SQLite's writer
 * lock; a failed database commit restores the room's previous in-memory state.
 */
export class AuthorizedRelayDelivery {
 private readonly db:Database.Database;
 private readonly relay:OpaqueRendezvous;
 private readonly secret:string;
 private readonly clock:Clock;
 private readonly wallClock:()=>number;
 constructor(db:Database.Database,relay:OpaqueRendezvous,secret:string,clock:Clock,wallClock:()=>number){this.db=db;this.relay=relay;this.secret=secret;this.clock=clock;this.wallClock=wallClock;}
 private run<T>(owner:string,participant:Participant,actor:RendezvousActor,operation:()=>T):T {
  const expected=participant.request.role==='camera'?'owner':'guest';
  if(actor.role!==expected||(actor.role==='owner'&&actor.owner!==owner))throw Error('RELAY_DENIED');
  return this.relay.withRoomRollback(participant.request.roomId,()=>{
   let result:T|undefined;
   const valid=verifyRelayPeerBinding(this.db,owner,participant,this.clock,
    session=>resolveRelayBrowserSession(this.db,this.secret,owner,session,this.wallClock),
    ()=>{result=operation();});
   if(!valid)throw Error('RELAY_DENIED');
   return result as T;
  });
 }
 send(owner:string,participant:Participant,actor:RendezvousActor,sequence:number,bytes:Uint8Array){return this.run(owner,participant,actor,()=>this.relay.send(participant.request.roomId,actor,sequence,bytes));}
 peek(owner:string,participant:Participant,actor:RendezvousActor){return this.run(owner,participant,actor,()=>this.relay.peek(participant.request.roomId,actor));}
 acknowledge(owner:string,participant:Participant,actor:RendezvousActor,sequence:number){return this.run(owner,participant,actor,()=>this.relay.acknowledge(participant.request.roomId,actor,sequence));}
}
