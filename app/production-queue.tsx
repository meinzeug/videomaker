'use client';
import {useEffect,useState} from 'react';
import {ArrowRight, Clapperboard, RefreshCw} from 'lucide-react';
import type {Channel} from '@/lib/channels';
import type {ProductionQueueItem} from '@/lib/production-queue';

type Result={total:number;items:ProductionQueueItem[]};
export default function ProductionQueue({channels,onOpen}:{channels:Channel[];onOpen:(id:string)=>Promise<void>}){
 const [channel,setChannel]=useState(''),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[opening,setOpening]=useState<string|null>(null);
 useEffect(()=>{
  const controller=new AbortController();setResult(null);setError('');
  const params=channel?`?channel=${encodeURIComponent(channel)}`:'';
  void fetch(`/api/production-queue${params}`,{cache:'no-store',signal:controller.signal}).then(async response=>{
   const data=await response.json();if(!response.ok)throw new Error(data.error||'Produktionsübersicht nicht verfügbar.');
   if(!controller.signal.aborted)setResult(data as Result);
  }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Produktionsübersicht nicht verfügbar.');});
  return()=>controller.abort();
 },[channel,refresh]);
 const names=new Map(channels.map(item=>[item.id,item]));
 return <section className="production-queue panel" aria-labelledby="production-queue-title">
  <div className="production-queue-heading"><div><p className="eyebrow">DEINE PRODUKTION</p><h2 id="production-queue-title">Skripte für die Aufnahme<span>.</span></h2><p>Hier siehst du Skripte ohne auf diesem Server vermerkte Aufnahme.</p></div>
   <label>Kanal<select value={channel} onChange={event=>setChannel(event.target.value)}><option value="">Alle Kanäle</option><option value="unassigned">Ohne Kanal</option>{channels.map(item=><option key={item.id} value={item.id}>{item.name} · {item.platform}</option>)}</select></label>
  </div>
  {error?<div className="production-queue-state" role="alert"><p>{error}</p><button className="secondary-action" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/> Erneut laden</button></div>:!result?<p className="production-queue-state" role="status">Skripte werden geladen …</p>:result.items.length===0?<p className="production-queue-state">Für diese Auswahl ist derzeit kein Skript ohne vermerkte Serveraufnahme vorhanden.</p>:<>
   <p className="production-queue-count">{result.total} {result.total===1?'Skript':'Skripte'} ohne vermerkte Serveraufnahme{result.total>result.items.length?` · ${result.items.length} neueste angezeigt`:''}</p>
   <div className="production-queue-list">{result.items.map(item=><div className="production-queue-row" key={item.id}><span className="production-queue-icon"><Clapperboard size={17}/></span><div className="production-queue-copy"><b>{item.title}</b><span>{item.channelIds.length?item.channelIds.map(id=>{const c=names.get(id);return c?`${c.name} · ${c.platform}`:'Kanal nicht verfügbar';}).join(' / '):'Keinem Kanal zugeordnet'}</span></div><button className="secondary-action" type="button" disabled={opening!==null} onClick={()=>{setOpening(item.id);void onOpen(item.id).finally(()=>setOpening(null));}}>{opening===item.id?'Wird geöffnet …':'Teleprompter'} <ArrowRight size={15}/></button></div>)}</div>
  </>}
  <p className="production-queue-note">Lokale Aufnahmen, redaktionelle Freigaben und Geräteverbindungen werden hier nicht geprüft.</p>
 </section>;
}
