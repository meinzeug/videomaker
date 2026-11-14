'use client';
import {useCallback,useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';

type Status={state:'disabled'|'idle'|'starting'|'fetching'|'patching'|'prepared'|'failed'|'unknown';message:string;commit?:string;updatedAt?:string};
export default function HabenSettings(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false);
 const refresh=useCallback(async()=>{
  try{const response=await fetch('/api/haben-update',{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Status konnte nicht geladen werden.');setStatus(data);setError('');}
  catch(e){setError(e instanceof Error?e.message:'Status konnte nicht geladen werden.');}
 },[]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),4000);return()=>clearInterval(timer);},[refresh]);
 const busy=starting||status?.state==='disabled'||status?.state==='starting'||status?.state==='fetching'||status?.state==='patching'||status?.state==='unknown';
 async function start(){setStarting(true);setError('');try{const response=await fetch('/api/haben-update',{method:'POST'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Vorbereitung fehlgeschlagen.');await refresh();}catch(e){setError(e instanceof Error?e.message:'Vorbereitung fehlgeschlagen.');}finally{setStarting(false);}}
 return <section className="panel haben-settings" aria-labelledby="haben-update-title"><p className="eyebrow">BUCHHALTUNG</p><h2 id="haben-update-title">Haben aktualisieren</h2><p>Aktuellen Quelltext von Haben laden und die Videomaker-Anpassungen in einem getrennten Kandidaten vorbereiten.</p><p>Der Kandidat wird dabei <strong>nicht getestet oder installiert</strong>. Es findet keine Datenbankänderung statt. Für die Übernahme sind weitere Prüfungen und eine Sicherung erforderlich.</p><button type="button" className="primary" disabled={busy||!status} onClick={()=>void start()}><RefreshCw size={16}/> {status?.state==='disabled'?'Noch nicht verfügbar':busy?'Vorbereitung läuft …':'Update vorbereiten'}</button><p role="status" aria-live="polite">{status?.message||'Status wird geladen …'}</p>{status?.commit&&<p>Quellstand: <code>{status.commit}</code></p>}{status?.updatedAt&&<p>Zuletzt aktualisiert: {new Date(status.updatedAt).toLocaleString('de-DE')}</p>}{error&&<p className="alert" role="alert">{error}</p>}</section>;
}
