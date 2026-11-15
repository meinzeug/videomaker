import Database from 'better-sqlite3';
import {createOwnedDeviceAuth} from '../../experiments/studio-device-http/owned-device-auth-core.mjs';
const [file,secret,device,token,signature]=process.argv.slice(2);
if(!file?.startsWith('/dev/shm/studio-owned-auth.')||!/^[0-9a-f]{64}$/.test(secret||''))throw Error('Invalid fixture');
const db=new Database(file,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('synchronous=FULL');
const auth=createOwnedDeviceAuth(db,Date.now,Buffer.from(secret,'hex'));process.send('ready');
process.once('message',()=>{try{process.send({issued:!!auth.completeLogin(device,token,Buffer.from(signature,'base64url'))});}finally{db.close();}});
