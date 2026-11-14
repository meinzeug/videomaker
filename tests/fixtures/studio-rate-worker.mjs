import Database from 'better-sqlite3';
import {admitStudioRateFixture} from '../../experiments/studio-rendezvous/rate-limit.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
let input='';for await(const part of process.stdin)input+=part;const value=JSON.parse(input),db=new Database(value.path);db.pragma('foreign_keys=ON');
try{process.exitCode=admitStudioRateFixture(db,value.identity,Buffer.from(value.secret,'base64'),()=>value.clock,{ip:3,owner:3,session:3})?0:2;}catch{process.exitCode=3;}finally{db.close();}
