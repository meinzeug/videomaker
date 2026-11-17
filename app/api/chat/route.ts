import {authorized,sameOrigin} from '@/lib/auth';
import {CHAT_CONTEXT_MESSAGES,CHAT_MESSAGE_MAX,ChatProviderError,FIELD_MAX,SCRIPT_MAX,chatResponse,chatSystemPrompt,isChatKind,type ChatKind} from '@/lib/chat';
import db from '@/lib/db';
import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export const maxDuration=300;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const fail=(error:string,status:number)=>NextResponse.json({error},{status,headers});

/** The thread's subject must exist; returns the context for the system prompt. */
function subject(kind:ChatKind,refId:string,draft:unknown){
 const database=db();
 if(kind==='script'){
  const row=database.prepare('SELECT title,content FROM projects WHERE id=?').get(refId) as {title:string;content:string}|undefined;
  if(!row)return null;
  let script='';try{script=String(JSON.parse(row.content).script||'');}catch{}
  return {title:row.title,text:script};
 }
 const row=database.prepare('SELECT name,dramaturgy,instructions FROM channels WHERE id=?').get(refId) as {name:string;dramaturgy:string;instructions:string}|undefined;
 if(!row)return null;
 const own=kind==='channel_dramaturgy'?row.dramaturgy:row.instructions,other=kind==='channel_dramaturgy'?row.instructions:row.dramaturgy;
 return {channel:row.name,text:typeof draft==='string'?draft.slice(0,10000):own,other};
}
/** Write performed on the model's explicit tool call; the previous script version is kept as a backup. */
function saveFromChat(kind:ChatKind,refId:string,text:string):{ok:boolean;message:string;saved?:unknown}{
 const database=db(),value=text.trim();
 if(!value)return {ok:false,message:'Leerer Text wurde nicht gespeichert.'};
 if(kind==='script'){
  if(value.length>SCRIPT_MAX)return {ok:false,message:`Text zu lang (maximal ${SCRIPT_MAX} Zeichen).`};
  const row=database.prepare('SELECT content FROM projects WHERE id=?').get(refId) as {content:string}|undefined;
  if(!row)return {ok:false,message:'Skript nicht gefunden.'};
  const content=JSON.parse(row.content);
  if(typeof content.script==='string'&&content.script!==value)content.script_backups=[{saved_at:new Date().toISOString(),script:content.script},...(Array.isArray(content.script_backups)?content.script_backups:[])].slice(0,5);
  content.script=value;
  database.prepare('UPDATE projects SET content=? WHERE id=?').run(JSON.stringify(content),refId);
  return {ok:true,message:'Das Skript wurde gespeichert.',saved:{kind,script:value}};
 }
 if(value.length>FIELD_MAX)return {ok:false,message:`Text zu lang: ${value.length} Zeichen, erlaubt sind ${FIELD_MAX}. Bitte kürzen und erneut speichern.`};
 const column=kind==='channel_dramaturgy'?'dramaturgy':'instructions';
 const info=database.prepare(`UPDATE channels SET ${column}=? WHERE id=?`).run(value,refId);
 return info.changes?{ok:true,message:'Das Feld wurde gespeichert.',saved:{kind,text:value}}:{ok:false,message:'Kanal nicht gefunden.'};
}
/** The last CHAT_CONTEXT_MESSAGES messages are sent with every request; the history always starts with a user message. */
function contextHistory(all:Array<{role:string;content:string}>){
 let start=Math.max(0,all.length-CHAT_CONTEXT_MESSAGES);
 while(start<all.length&&all[start].role!=='user')start++;
 return all.slice(start);
}
function target(kind:unknown,refId:unknown){return isChatKind(kind)&&typeof refId==='string'&&/^[0-9a-f-]{36}$/i.test(refId)?{kind,refId:refId.toLowerCase()}:null;}

export async function GET(req:Request){
 if(!await authorized())return fail('Nicht angemeldet',401);
 const url=new URL(req.url),t=target(url.searchParams.get('kind'),url.searchParams.get('refId'));
 if(!t)return fail('Ungültiger Chat.',400);
 const messages=db().prepare('SELECT id,role,content,created_at FROM chat_messages WHERE kind=? AND ref_id=? ORDER BY created_at,rowid').all(t.kind,t.refId);
 return NextResponse.json({messages},{headers});
}

export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return fail('Nicht erlaubt',403);
 const data=await req.json().catch(()=>null) as Record<string,unknown>|null;
 const t=target(data?.kind,data?.refId);
 const message=typeof data?.message==='string'?data.message.trim():'';
 if(!t||!message)return fail('Ungültige Nachricht.',400);
 if(message.length>CHAT_MESSAGE_MAX)return fail(`Nachrichten dürfen höchstens ${CHAT_MESSAGE_MAX.toLocaleString('de-DE')} Zeichen lang sein.`,400);
 const context=subject(t.kind,t.refId,data?.draft);
 if(!context)return fail(t.kind==='script'?'Skript nicht gefunden.':'Kanal nicht gefunden.',404);
 const database=db(),userId=randomUUID();
 database.prepare('INSERT INTO chat_messages(id,kind,ref_id,role,content,created_at) VALUES(?,?,?,?,?,?)').run(userId,t.kind,t.refId,'user',message,new Date().toISOString());
 const undo=()=>{try{database.prepare('DELETE FROM chat_messages WHERE id=?').run(userId);}catch{}};
 try{
  const history=contextHistory(database.prepare('SELECT role,content FROM chat_messages WHERE kind=? AND ref_id=? ORDER BY created_at,rowid').all(t.kind,t.refId) as Array<{role:string;content:string}>);
  const save=(text:string)=>saveFromChat(t.kind,t.refId,text);
  const body=await chatResponse(t.kind,chatSystemPrompt(t.kind,context),history,save,text=>{database.prepare('INSERT INTO chat_messages(id,kind,ref_id,role,content,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),t.kind,t.refId,'assistant',text,new Date().toISOString());},undo);
  return new Response(body,{headers:{...headers,'Content-Type':'text/plain; charset=utf-8','X-Accel-Buffering':'no'}});
 }catch(error){
  undo();
  if(error instanceof ChatProviderError)return fail(error.message,error.status===429?429:error.status===402?402:502);
  return fail(error instanceof Error&&error.name==='TimeoutError'?'Die KI hat nicht rechtzeitig geantwortet.':error instanceof Error?error.message:'Chat fehlgeschlagen.',500);
 }
}

export async function DELETE(req:Request){
 if(!await authorized()||!await sameOrigin(req))return fail('Nicht erlaubt',403);
 const url=new URL(req.url),t=target(url.searchParams.get('kind'),url.searchParams.get('refId'));
 if(!t)return fail('Ungültiger Chat.',400);
 db().prepare('DELETE FROM chat_messages WHERE kind=? AND ref_id=?').run(t.kind,t.refId);
 return NextResponse.json({ok:true},{headers});
}
