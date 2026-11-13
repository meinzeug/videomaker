import {authorized,sameOrigin} from '@/lib/auth';
import {isUuid,parseCommand} from '@/lib/live-devices';
import db from '@/lib/db';
import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;if(!isUuid(id))return NextResponse.json({error:'Ungültiges Gerät.'},{status:400});
 let command;try{command=parseCommand(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiger Befehl.'},{status:400});}
 const now=Date.now(),database=db();
 const result=database.transaction(()=>{
  const device=database.prepare('SELECT role FROM live_devices WHERE id=? AND last_seen>?').get(id,now-10000) as {role:string}|undefined;
  if(!device)return 'offline';
  if(device.role!=='prompter')return 'role';
  if(command.projectId&&!database.prepare('SELECT 1 FROM projects WHERE id=?').get(command.projectId))return 'project';
  if((database.prepare('SELECT count(*) as n FROM live_commands WHERE device_id=? AND expires_at>?').get(id,now) as {n:number}).n>=32)return 'busy';
  database.prepare('INSERT INTO live_commands(id,device_id,type,project_id,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,command.type,command.projectId,now,now+10000);return 'ok';
 })();
 if(result!=='ok')return NextResponse.json({error:result==='offline'?'Gerät ist nicht erreichbar.':result==='role'?'Befehl benötigt ein Anzeigegerät.':result==='project'?'Skript nicht gefunden.':'Gerät verarbeitet noch Befehle.'},{status:result==='project'?404:409});
 return NextResponse.json({queued:true});
}
