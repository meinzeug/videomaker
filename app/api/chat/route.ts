import {authorized,sameOrigin} from '@/lib/auth';
import {CHAT_CONTEXT_MESSAGES,CHAT_MESSAGE_MAX,chatSystemPrompt,isChatKind,openChatStream,textStream,type ChatKind} from '@/lib/chat';
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
  const history=(database.prepare('SELECT role,content FROM chat_messages WHERE kind=? AND ref_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(t.kind,t.refId,CHAT_CONTEXT_MESSAGES) as Array<{role:string;content:string}>).reverse();
  const upstream=await openChatStream(chatSystemPrompt(t.kind,context),history);
  if(!upstream.ok||!upstream.body){
   const detail=await upstream.json().catch(()=>({})) as {error?:{message?:string}};
   undo();
   return fail(`KI-Anfrage fehlgeschlagen (${upstream.status})${detail?.error?.message?` – ${String(detail.error.message).slice(0,200)}`:''}`,upstream.status===429?429:upstream.status===402?402:502);
  }
  const body=textStream(upstream.body,text=>{database.prepare('INSERT INTO chat_messages(id,kind,ref_id,role,content,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),t.kind,t.refId,'assistant',text,new Date().toISOString());},undo);
  return new Response(body,{headers:{...headers,'Content-Type':'text/plain; charset=utf-8','X-Accel-Buffering':'no'}});
 }catch(error){
  undo();
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
