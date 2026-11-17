'use client';
import {Fragment,useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowUp,Globe,Sparkles,Square,Trash2,X} from 'lucide-react';
import type {ChatKind,ChatMessage} from '@/lib/chat';

/** Minimaler, sicherer Markdown-Renderer (kein HTML, nur React-Elemente). */
function inline(text:string):ReactNode[] {
 const out:ReactNode[]=[],pattern=/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)<]+)/g;
 let last=0,match:RegExpExecArray|null,key=0;
 while((match=pattern.exec(text))){
  if(match.index>last)out.push(text.slice(last,match.index));
  const token=match[0];
  if(token.startsWith('**'))out.push(<strong key={key++}>{token.slice(2,-2)}</strong>);
  else if(token.startsWith('`'))out.push(<code key={key++}>{token.slice(1,-1)}</code>);
  else if(token.startsWith('[')){const m=/^\[([^\]]+)\]\((.+)\)$/.exec(token)!;out.push(<a key={key++} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);}
  else out.push(<a key={key++} href={token} target="_blank" rel="noopener noreferrer">{token}</a>);
  last=match.index+token.length;
 }
 if(last<text.length)out.push(text.slice(last));
 return out;
}
function Markdown({text}:{text:string}) {
 const blocks:ReactNode[]=[],lines=text.replace(/\r\n/g,'\n').split('\n');
 let i=0,key=0;
 while(i<lines.length){
  const line=lines[i];
  if(line.trim().startsWith('```')){const code:string[]=[];i++;while(i<lines.length&&!lines[i].trim().startsWith('```'))code.push(lines[i++]);i++;blocks.push(<pre key={key++}><code>{code.join('\n')}</code></pre>);continue;}
  const heading=/^(#{1,4})\s+(.*)$/.exec(line);
  if(heading){blocks.push(<h4 key={key++}>{inline(heading[2])}</h4>);i++;continue;}
  if(/^\s*[-*]\s+/.test(line)){const items:string[]=[];while(i<lines.length&&/^\s*[-*]\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*[-*]\s+/,''));blocks.push(<ul key={key++}>{items.map((item,n)=><li key={n}>{inline(item)}</li>)}</ul>);continue;}
  if(/^\s*\d+[.)]\s+/.test(line)){const items:string[]=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*\d+[.)]\s+/,''));blocks.push(<ol key={key++}>{items.map((item,n)=><li key={n}>{inline(item)}</li>)}</ol>);continue;}
  if(!line.trim()){i++;continue;}
  const para:string[]=[];
  while(i<lines.length&&lines[i].trim()&&!/^(#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|```)/.test(lines[i]))para.push(lines[i++]);
  blocks.push(<p key={key++}>{para.map((l,n)=><Fragment key={n}>{n>0&&<br/>}{inline(l)}</Fragment>)}</p>);
 }
 return <>{blocks}</>;
}

export type ChatSaved={kind:ChatKind;text?:string;script?:string};
/** Entfernt Speicher-Markierungen (auch unvollständige) aus dem Stream. */
const MARK=/\u001e[^\u001e]*\u001e/g;
const visible=(text:string)=>text.replace(MARK,'').replace(/\u001e[^\u001e]*$/,'');
export type ChatTarget={kind:ChatKind;refId:string;/** Aktueller, evtl. ungespeicherter Feldentwurf (nur Kanal-Chats). */draft?:string};
type Item=Pick<ChatMessage,'role'|'content'>&{id:string;pending?:boolean};

export function ChatThread({kind,refId,draft,intro,suggestions=[],onSaved}:ChatTarget&{intro:string;suggestions?:string[];onSaved?:(saved:ChatSaved)=>void}) {
 const [messages,setMessages]=useState<Item[]>([]),[input,setInput]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const list=useRef<HTMLDivElement>(null),box=useRef<HTMLTextAreaElement>(null),abort=useRef<AbortController|null>(null),stick=useRef(true);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setMessages([]);
  fetch(`/api/chat?kind=${kind}&refId=${encodeURIComponent(refId)}`,{signal:controller.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Chat konnte nicht geladen werden.');setMessages(d.messages);}).catch(e=>{if(e.name!=='AbortError')setError(e instanceof Error?e.message:'Chat konnte nicht geladen werden.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>{controller.abort();abort.current?.abort();};
 },[kind,refId]);
 useLayoutEffect(()=>{const el=list.current;if(el&&stick.current)el.scrollTop=el.scrollHeight;},[messages,loading]);
 useLayoutEffect(()=>{const el=box.current;if(el){el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,200)}px`;}},[input]);
 const send=useCallback(async(text:string)=>{
  const message=text.trim();if(!message||busy)return;
  setError('');setInput('');setBusy(true);stick.current=true;
  const userItem:Item={id:`u-${Date.now()}`,role:'user',content:message},botItem:Item={id:`a-${Date.now()}`,role:'assistant',content:'',pending:true};
  setMessages(items=>[...items,userItem,botItem]);
  const controller=new AbortController();abort.current=controller;
  try{
   const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,refId,message,...(draft!==undefined?{draft}:{})}),signal:controller.signal});
   if(!response.ok||!response.body){const d=await response.json().catch(()=>({}));throw new Error(d.error||'Chat fehlgeschlagen.');}
   const reader=response.body.getReader(),decoder=new TextDecoder();let full='',seen=0;
   for(;;){const {done,value}=await reader.read();if(done)break;full+=decoder.decode(value,{stream:true});const marks=[...full.matchAll(MARK)];for(;seen<marks.length;seen++){try{onSaved?.(JSON.parse(marks[seen][0].slice(1,-1)));}catch{}}const shown=visible(full);setMessages(items=>items.map(item=>item.id===botItem.id?{...item,content:shown}:item));}
   setMessages(items=>items.map(item=>item.id===botItem.id?{...item,pending:false}:item));
  }catch(e){
   const stopped=e instanceof Error&&e.name==='AbortError';
   if(stopped){setMessages(items=>items.map(item=>item.id===botItem.id?{...item,pending:false}:item).filter(item=>item.content));}
   else{setMessages(items=>items.filter(item=>item.id!==userItem.id&&item.id!==botItem.id));setInput(message);setError(e instanceof Error?e.message:'Chat fehlgeschlagen.');}
  }finally{abort.current=null;setBusy(false);box.current?.focus();}
 },[busy,kind,refId,draft]);
 async function clear(){
  if(busy||!messages.length||!confirm('Gesamten Chatverlauf löschen?'))return;
  try{const r=await fetch(`/api/chat?kind=${kind}&refId=${encodeURIComponent(refId)}`,{method:'DELETE'});if(!r.ok)throw new Error();setMessages([]);}catch{setError('Verlauf konnte nicht gelöscht werden.');}
 }
 return <div className="chat">
  <div className="chat-scroll" ref={list} onScroll={e=>{const el=e.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}} role="log" aria-live="polite" aria-label="Chatverlauf">
   {loading?<p className="chat-hint">Chat wird geladen …</p>:!messages.length?<div className="chat-empty"><span className="chat-logo"><Sparkles size={22}/></span><p>{intro}</p><small><Globe size={12}/> Die KI kann bei Bedarf im Internet recherchieren und auf deine Bitte Texte speichern.</small>{suggestions.length>0&&<div className="chat-suggestions">{suggestions.map(s=><button key={s} type="button" onClick={()=>void send(s)} disabled={busy}>{s}</button>)}</div>}</div>
   :messages.map(m=><div key={m.id} className={`chat-msg ${m.role}`}>{m.role==='assistant'&&<span className="chat-avatar" aria-hidden="true"><Sparkles size={14}/></span>}<div className="chat-bubble">{m.role==='user'?<p>{m.content}</p>:m.content?<Markdown text={m.content}/>:null}{m.pending&&<span className="chat-typing" aria-label="KI antwortet"><i/><i/><i/></span>}</div></div>)}
  </div>
  {error&&<p className="chat-error" role="alert">{error}</p>}
  <form className="chat-composer" onSubmit={e=>{e.preventDefault();void send(input);}}>
   <textarea ref={box} rows={1} value={input} maxLength={8000} placeholder="Nachricht schreiben …" aria-label="Nachricht" disabled={loading} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send(input);}}}/>
   {busy?<button type="button" className="chat-send stop" aria-label="Antwort stoppen" onClick={()=>abort.current?.abort()}><Square size={14} fill="currentColor"/></button>:<button type="submit" className="chat-send" aria-label="Senden" disabled={!input.trim()||loading}><ArrowUp size={18}/></button>}
  </form>
  <div className="chat-foot"><span>Enter sendet · Shift+Enter neue Zeile · KI-Antworten können Fehler enthalten.</span><button type="button" className="chat-clear" onClick={()=>void clear()} disabled={busy||!messages.length}><Trash2 size={13}/> Verlauf löschen</button></div>
 </div>;
}

export function ChatModal({title,subtitle,onClose,...thread}:{title:string;subtitle?:string;onClose:()=>void}&Parameters<typeof ChatThread>[0]) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const el=dialog.current;if(!el)return;el.showModal();return()=>{if(el.open)el.close();};},[]);
 return <dialog ref={dialog} className="chat-dialog" aria-labelledby="chat-dialog-title" onClose={onClose} onClick={e=>{if(e.target===dialog.current)dialog.current?.close();}}>
  <div className="chat-dialog-head"><div><p className="eyebrow">KI-CHAT</p><h2 id="chat-dialog-title">{title}</h2>{subtitle&&<small>{subtitle}</small>}</div><button type="button" className="icon" aria-label="Chat schließen" onClick={()=>dialog.current?.close()}><X size={20}/></button></div>
  <ChatThread {...thread}/>
 </dialog>;
}
