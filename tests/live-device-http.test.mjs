import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {registerHooks} from 'node:module';
import Database from 'better-sqlite3';
import {ensureLiveDeviceControlSchema} from '../lib/live-device-schema.ts';

// Test actual route handlers and HTTP framing against a private in-memory DB.
const sourceRoot=new URL('../',import.meta.url);
const mock=(source)=>`data:text/javascript,${encodeURIComponent(source)}`;
const auth=mock(`export async function authorized(){return globalThis.__deviceAuth;} export async function sameOrigin(req){return req.headers.get('origin')==='http://fixture.local';} export async function sessionValue(){return 'fixture';} export function sessionAuthorized(){return globalThis.__deviceAuth;}`);
const database=mock(`export default function db(){return globalThis.__deviceDatabase;}`);
const next=mock(`export class NextResponse extends Response {static json(value,init){return Response.json(value,init);}}`);
registerHooks({resolve(specifier,context,resolve){
 if(specifier==='@/lib/auth')return {url:auth,shortCircuit:true};
 if(specifier==='@/lib/db')return {url:database,shortCircuit:true};
 if(specifier==='next/server')return {url:next,shortCircuit:true};
 if(specifier.startsWith('@/'))return {url:new URL(specifier.slice(2)+'.ts',sourceRoot).href,shortCircuit:true};
 return resolve(specifier,context);
}});
const poll=await import('../app/api/devices/poll/route.ts');
const command=await import('../app/api/devices/[id]/commands/route.ts');
const list=await import('../app/api/devices/route.ts');
const id='12c3267c-c343-41d1-8245-2a88107e7213';
function setup(){
 const db=new Database(':memory:');db.exec(`CREATE TABLE live_devices(id TEXT PRIMARY KEY,name TEXT,role TEXT,status TEXT,last_seen INTEGER);CREATE TABLE live_commands(id TEXT PRIMARY KEY,device_id TEXT,type TEXT,project_id TEXT,created_at INTEGER,expires_at INTEGER);CREATE TABLE projects(id TEXT PRIMARY KEY);`);ensureLiveDeviceControlSchema(db);globalThis.__deviceDatabase=db;globalThis.__deviceAuth=true;return db;
}
const payload=(overrides={})=>({id,name:'Fixture',role:'prompter',status:'bereit',ack:[],controls:{speed:35,fontSize:44},...overrides});
function request(body,origin='http://fixture.local'){return new Request('http://fixture.local/api',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body)});}
test('real HTTP framing drives phone setting queue and acknowledged device state',async()=>{
 const db=setup();const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://fixture.local');
   const web=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
   const result=url.pathname==='/api/devices/poll'?await poll.POST(web):url.pathname==='/api/devices'?await list.GET():await command.POST(web,{params:Promise.resolve({id})});
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,base=`http://127.0.0.1:${port}`;
 const post=(path,body,origin='http://fixture.local')=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
 try{
  assert.equal((await post('/api/devices/poll',payload({controls:{speed:76,fontSize:44}}))).status,200);
  const sentResponse=await post(`/api/devices/${id}/commands`,{type:'set_speed',value:76});assert.equal(sentResponse.status,200);const sent=await sentResponse.json();assert.match(sent.commandId,/^[0-9a-f-]{36}$/);
  const before=await (await fetch(base+'/api/devices')).json();assert.equal(before.devices[0].speed,76);assert.ok(!before.devices[0].acknowledged.includes(sent.commandId));
  const reply=await (await post('/api/devices/poll',payload())).json();assert.equal(reply.commands.length,1);assert.equal(reply.commands[0].type,'set_speed');assert.equal(reply.commands[0].value,76);assert.equal(reply.commands[0].id,sent.commandId);
  assert.equal((await post('/api/devices/poll',payload({ack:[reply.commands[0].id],controls:{speed:76,fontSize:44}}))).status,200);
  const devices=await (await fetch(base+'/api/devices')).json();assert.equal(devices.devices[0].speed,76);assert.ok(devices.devices[0].acknowledged.includes(sent.commandId));assert.equal(db.prepare('SELECT count(*) AS n FROM live_commands').get().n,0);
  assert.equal((await post(`/api/devices/${id}/commands`,{type:'set_font_size',value:64})).status,200);
  const font=await (await post('/api/devices/poll',payload({controls:{speed:76,fontSize:44}}))).json();assert.equal(font.commands[0].type,'set_font_size');assert.equal(font.commands[0].value,64);
  assert.equal((await post('/api/devices/poll',payload({ack:[font.commands[0].id],controls:{speed:76,fontSize:64}}))).status,200);
  const project='ec310715-9c72-42fd-9945-f3cdd34e615c';db.prepare('INSERT INTO projects(id) VALUES(?)').run(project);
  assert.equal((await post(`/api/devices/${id}/commands`,{type:'load',projectId:project})).status,200);
  const load=await (await post('/api/devices/poll',payload({controls:{speed:76,fontSize:44}}))).json();assert.equal(load.commands[0].type,'load');assert.equal(load.commands[0].projectId,project);
  assert.equal((await post('/api/devices/poll',payload({ack:[load.commands[0].id],controls:{speed:76,fontSize:44}}))).status,200);
  for(const type of ['play','pause','reset']){
   assert.equal((await post(`/api/devices/${id}/commands`,{type})).status,200);
   const queued=await (await post('/api/devices/poll',payload({controls:{speed:76,fontSize:44}}))).json();assert.equal(queued.commands[0].type,type);
   assert.equal((await post('/api/devices/poll',payload({ack:[queued.commands[0].id],controls:{speed:76,fontSize:44}}))).status,200);
  }
  assert.equal((await post(`/api/devices/${id}/commands`,{type:'set_font_size',value:200})).status,400);
  assert.equal((await post(`/api/devices/${id}/commands`,{type:'pause'},'http://evil.invalid')).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
test('logout during slow body prevents command insertion inside transaction',async()=>{
 const db=setup();try{
  await poll.POST(request(payload()));
  let controller;const stream=new ReadableStream({start(value){controller=value;}});
  const web=new Request('http://fixture.local/api',{method:'POST',headers:{origin:'http://fixture.local'},body:stream,duplex:'half'});
  const result=command.POST(web,{params:Promise.resolve({id})});
  await new Promise(resolve=>setTimeout(resolve,20));globalThis.__deviceAuth=false;
  controller.enqueue(new TextEncoder().encode('{"type":"set_speed","value":45}'));controller.close();
  assert.equal((await result).status,401);assert.equal(db.prepare('SELECT count(*) AS n FROM live_commands').get().n,0);
 }finally{db.close();}
});
