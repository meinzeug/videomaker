import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {createDeviceHttpFixture} from '../../experiments/studio-device-http/router.mjs';

// Synthetic secret, DB and port are supplied only by the parent fixture.
const [filename,challengeHex,ownerHex]=process.argv.slice(2);
if(!filename?.startsWith('/dev/shm/studio-http-race.')||!/^[0-9a-f]{64}$/.test(challengeHex||'')||!/^[0-9a-f]{64}$/.test(ownerHex||''))throw Error('Invalid test fixture');
const db=new Database(filename,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('synchronous=FULL');
const server=createServer(createDeviceHttpFixture({db,challengeSecret:Buffer.from(challengeHex,'hex'),ownerSecret:Buffer.from(ownerHex,'hex')}));
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',message=>{if(message==='stop')server.close(()=>{db.close();process.disconnect();});});
