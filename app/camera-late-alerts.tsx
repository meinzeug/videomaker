'use client';
import {useCallback,useEffect,useRef,useState} from 'react';

type Alert={cursor:number;recordingId:string;projectId:string;deviceId:string;projectTitle:string|null;phase:'error'|'partial';observedAt:number;size:number|null;sha256:string|null};
type Page={alerts:Alert[];hasMore:boolean;nextBefore:number|null;capacityReached:boolean};

/** Can be mounted outside a project so alerts survive deletion of the script. */
export default function CameraLateAlerts(){
 const [state,setState]=useState<'loading'|'disabled'|'ready'|'error'>('loading');
 const [alerts,setAlerts]=useState<Alert[]>([]),[next,setNext]=useState<number|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [capacityReached,setCapacityReached]=useState(false);
 const revision=useRef(0),older=useRef(false),mounted=useRef(false),disabled=useRef(false);
 const load=useCallback(async(before:number|null)=>{
  const current=++revision.current,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
  setLoading(true);
  try{
   const response=await fetch(`/api/camera-devices/alerts${before===null?'':`?before=${before}`}`,{cache:'no-store',signal:controller.signal});
   if(!mounted.current||current!==revision.current)return;
   if(response.status===404){disabled.current=true;setState('disabled');setAlerts([]);setNext(null);return;}
   if(!response.ok)throw Error();
   const data=await response.json() as Page;
   if(!data||!Array.isArray(data.alerts)||typeof data.hasMore!=='boolean'||typeof data.capacityReached!=='boolean'||(data.hasMore&&(!Number.isSafeInteger(data.nextBefore)||Number(data.nextBefore)<=0))||(!data.hasMore&&data.nextBefore!==null))throw Error();
   if(!mounted.current||current!==revision.current)return;
   setAlerts(previous=>before===null?data.alerts:[...previous,...data.alerts.filter(item=>!previous.some(old=>old.cursor===item.cursor))]);
   setNext(data.nextBefore);setCapacityReached(data.capacityReached);setState('ready');setError('');
  }catch{if(mounted.current&&current===revision.current){setState('error');setError('Kamerameldungen konnten nicht geladen werden.');}}
  finally{clearTimeout(timer);if(mounted.current&&current===revision.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;void load(null);const timer=setInterval(()=>{if(!older.current&&!disabled.current)void load(null);},10000);return()=>{mounted.current=false;revision.current++;clearInterval(timer);};},[load]);
 if(state==='disabled')return null;
 if(state==='loading'&&!alerts.length)return null;
 if(state==='ready'&&!alerts.length)return null;
 return <section className="panel device-control" aria-label="Späte Kamerameldungen">
  <p className="eyebrow">KAMERA</p><h2>Späte Kamerameldungen</h2>
  <p>Nach einem bestätigten Upload meldete das ursprüngliche Smartphone für diese Aufnahme einen Fehler oder Teilstatus. Prüfe die Aufnahme und das Gerät. Die Meldung verändert keine Uploadbelege und löscht keine Dateien.</p>
  {alerts.length>0&&<ul>{alerts.map(alert=>{
   const date=new Date(alert.observedAt),when=Number.isFinite(date.getTime())?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'}).format(date):'Zeit unbekannt';
   return <li key={alert.cursor}><strong>{alert.projectTitle||'Skript nicht mehr vorhanden'}</strong> · {alert.phase==='partial'?'Teilstatus':'Fehlermeldung'} · {when}<br/>Aufnahme <code>{alert.recordingId}</code><br/>Gerät <code>{alert.deviceId}</code>{!alert.projectTitle&&<><br/>Skript-ID <code>{alert.projectId}</code></>}{alert.phase==='partial'&&<details><summary>Gemeldete Dateidaten</summary>{alert.size} Bytes · SHA-256 <code>{alert.sha256}</code></details>}</li>;
  })}</ul>}
  {error&&<p role="alert">{error}</p>}
  {capacityReached&&<p role="alert">Der Speicher für Kamerameldungen ist voll. Neue unterschiedliche Meldungen können nicht angenommen werden.</p>}
  {next!==null&&<button type="button" className="secondary-action" disabled={loading} onClick={()=>{older.current=true;void load(next);}}>Ältere Meldungen laden</button>}
  <button type="button" className="secondary-action" disabled={loading} onClick={()=>{older.current=false;void load(null);}}>Aktualisieren</button>
 </section>;
}
