import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createStudioRoomFixture} from '../../experiments/studio-rendezvous/core.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data),db=new Database(input.path);db.pragma('foreign_keys=ON');
try{const result=createStudioRoomFixture(db,input.camera,Buffer.from(input.secret,'base64'),()=>input.clock,()=>true);process.stdout.write(JSON.stringify({roomId:result.roomId,codeHash:createHash('sha256').update(result.joinCode).digest('hex'),created:result.created}));process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
