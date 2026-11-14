import Database from 'better-sqlite3';
import {joinStudioRoomFixture} from '../../experiments/studio-rendezvous/core.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
let body='';for await(const chunk of process.stdin)body+=chunk;const input=JSON.parse(body),db=new Database(input.path);db.pragma('foreign_keys=ON');
try{joinStudioRoomFixture(db,input.fields,()=>input.clock,()=>true);process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
