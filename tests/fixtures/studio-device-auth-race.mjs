import Database from 'better-sqlite3';
import {createStudioDeviceAuth} from '../../lib/studio-device-auth-core.mjs';
const [file,device,challengeToken,sig]=process.argv.slice(2);
const db=new Database(file,{timeout:5000});
process.send?.('ready');
process.on('message',()=>{
 try{const value=createStudioDeviceAuth(db,()=>1_000_000,Buffer.alloc(32,17)).completeLogin(device,challengeToken,Buffer.from(sig,'base64'));process.send?.({accepted:!!value});}
 catch(error){process.send?.({error:String(error)});}finally{db.close();process.disconnect();}
});
