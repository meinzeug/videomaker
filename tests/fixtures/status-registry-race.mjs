import Database from 'better-sqlite3';
import {acceptStatusFixture} from '../../experiments/web-camera-status/fixture-status-registry.mjs';
process.env.NODE_ENV='test';process.env.WEB_STATUS_REGISTRY_FIXTURE='1';
const [file,mode,input]=process.argv.slice(2),args=JSON.parse(input),db=new Database(file,{timeout:5000});
process.send?.('ready');
process.on('message',()=>{
 try{
  const result=mode==='revoke'?db.transaction(()=>db.prepare('UPDATE status_fixture_pairs SET revoked=1').run().changes).immediate():
   acceptStatusFixture(db,args.binding,args.id,args.status,Buffer.from(args.signature,'base64'),()=>1_000_001);
  process.send?.({result});
 }catch(error){process.send?.({error:String(error)});}finally{db.close();process.disconnect();}
});
