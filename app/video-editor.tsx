'use client';

import {useEffect,useRef,useState} from 'react';
import {Clapperboard,Download,Play,Scissors} from 'lucide-react';
import type {Project} from './studio-types';
import {MAX_TRIM_SECONDS,MIN_TRIM_SECONDS,parseTrimRange} from '@/lib/video-trim';

type Recording={id:string;created_at:string;mime:string;size:number};
const seconds=(value:number)=>{
 if(!Number.isFinite(value)||value<0)return '–:–';
 const total=Math.round(value*100),minutes=Math.floor(total/6000),whole=Math.floor(total/100)%60,fraction=total%100;
 return `${minutes}:${String(whole).padStart(2,'0')}.${String(fraction).padStart(2,'0')}`;
};
const date=(value:string)=>new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(value));

export default function VideoEditor({projects,initialProjectId}:{projects:Project[];initialProjectId?:string}) {
 const [projectId,setProjectId]=useState(initialProjectId||projects[0]?.id||'');
 const [recordings,setRecordings]=useState<Recording[]|null>(null);
 const [recordingId,setRecordingId]=useState('');
 const [duration,setDuration]=useState(0),[start,setStart]=useState(0),[end,setEnd]=useState(0);
 const [position,setPosition]=useState(0);
 const [previewing,setPreviewing]=useState(false),[working,setWorking]=useState(false),[refreshing,setRefreshing]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[durationNotice,setDurationNotice]=useState('');
 const video=useRef<HTMLVideoElement>(null);
 const probingDuration=useRef(false),durationInitialized=useRef(false),probeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const base=`/api/projects/${encodeURIComponent(projectId)}/recordings`;
 useEffect(()=>{if(!projects.some(project=>project.id===projectId))setProjectId(projects.find(project=>project.id===initialProjectId)?.id||projects[0]?.id||'');},[projects,projectId,initialProjectId]);
 useEffect(()=>{
  if(!projectId){setRecordings([]);setRecordingId('');return;}
  const abort=new AbortController();setRecordings(null);setRecordingId('');setDuration(0);setPreviewing(false);setError('');setNotice('');
  fetch(base,{cache:'no-store',signal:abort.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'Aufnahmen konnten nicht geladen werden.');return data.recordings as Recording[];}).then(items=>{if(!abort.signal.aborted){setRecordings(items);setRecordingId(items[0]?.id||'');}}).catch(e=>{if(!abort.signal.aborted){setRecordings([]);setError(e instanceof Error?e.message:'Aufnahmen konnten nicht geladen werden.');}});
  return()=>abort.abort();
 },[base,projectId]);
 const source=recordingId?`${base}/${encodeURIComponent(recordingId)}`:'';
 useEffect(()=>()=>{if(probeTimer.current)clearTimeout(probeTimer.current);probeTimer.current=null;probingDuration.current=false;durationInitialized.current=false;},[source]);
 let valid=false;
 try{const range=parseTrimRange({start,end});valid=!!source&&duration>0&&range.end<=duration+0.05;}catch{/* invalid input remains editable */}
 function updateDuration(element:HTMLVideoElement,value:number){
  if(!Number.isFinite(value)||value<=0)return false;
  if(probeTimer.current)clearTimeout(probeTimer.current);probeTimer.current=null;
  const sought=probingDuration.current;probingDuration.current=false;setDurationNotice('');setDuration(value);
  if(!durationInitialized.current){durationInitialized.current=true;setStart(0);setEnd(Math.min(value,MAX_TRIM_SECONDS));}
  if(sought)try{element.currentTime=0;}catch{/* a disabled preview remains usable for saving */}
  return true;
 }
 function readDuration(element:HTMLVideoElement){
  if(updateDuration(element,element.duration))return;
  if(element.duration===Infinity&&!probingDuration.current){
   // MediaRecorder WebM may omit duration metadata. Seeking beyond EOF asks the browser to resolve it.
   probingDuration.current=true;setDurationNotice('Videolänge wird ermittelt …');
   try{element.currentTime=1e10;}catch{probingDuration.current=false;setDurationNotice('Die Videolänge konnte nicht ermittelt werden. Bitte eine andere Aufnahme verwenden.');return;}
   probeTimer.current=setTimeout(()=>{if(probingDuration.current){probingDuration.current=false;setDurationNotice('Die Videolänge konnte nicht ermittelt werden. Bitte eine andere Aufnahme verwenden.');try{element.currentTime=0;}catch{/* source is no longer seekable */}}},15000);
  }
 }
 async function refresh(){
  if(!projectId||working||refreshing)return;
  setRefreshing(true);setError('');
  try{const response=await fetch(base,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Aufnahmen konnten nicht geladen werden.');const items=data.recordings as Recording[];setRecordings(items);if(!items.some(item=>item.id===recordingId))setRecordingId(items[0]?.id||'');setNotice('Aufnahmen aktualisiert.');}
  catch(e){setError(e instanceof Error?e.message:'Aufnahmen konnten nicht geladen werden.');}finally{setRefreshing(false);}
 }
 async function render(){
  if(!valid||working||refreshing)return;
  setWorking(true);setError('');setNotice('');
  let savedId='';
  try {
   const response=await fetch(`${source}/trim`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start,end})});
   const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(data?.error||'Der Schnitt konnte nicht erstellt werden.');
   if(typeof data?.id!=='string')throw new TypeError('missing result');
   savedId=data.id;
   const refreshed=await fetch(base,{cache:'no-store'});const list=await refreshed.json();if(!refreshed.ok)throw new Error('Der Schnitt wurde gespeichert, aber die Liste konnte nicht aktualisiert werden.');
   setRecordings(list.recordings);setDuration(0);setPreviewing(false);setRecordingId(savedId);setNotice('Schnitt als neue Aufnahme gespeichert. Das Original bleibt erhalten.');
  } catch(e){setError(savedId?'Der Schnitt wurde gespeichert, aber die Liste konnte nicht aktualisiert werden. Bitte aktualisiere die Aufnahmen.':e instanceof TypeError?'Die Verbindung wurde unterbrochen. Bitte prüfe die Aufnahmen des Projekts, bevor du den Schnitt erneut startest.':e instanceof Error?e.message:'Der Schnitt konnte nicht erstellt werden.');}
  finally{setWorking(false);}
 }
 function playRange(){const el=video.current;if(!el||!valid)return;setError('');try{el.currentTime=start;setPreviewing(true);void el.play().catch(()=>{setPreviewing(false);setError('Die Vorschau konnte nicht gestartet werden.');});}catch{setPreviewing(false);setError('Die Vorschau konnte nicht gestartet werden.');}}
 function markPosition(which:'start'|'end'){
  const el=video.current;
  if(!el||!source||!duration||working||refreshing||probingDuration.current||!Number.isFinite(el.currentTime))return;
  // Use the element's live position, not the most recent timeupdate event.
  const value=Math.round(Math.max(0,Math.min(el.currentTime,duration))*1000)/1000;
  setPosition(value);
  if(which==='start')setStart(value);else setEnd(value);
  setError('');setNotice(`${which==='start'?'Anfang':'Ende'} bei ${seconds(value)} gesetzt.`);
 }
 if(!projects.length)return <section className="video-editor-empty"><Clapperboard size={28}/><h2>Bereit für deinen Schnitt?</h2><p>Lege zuerst ein Skript an und nimm dazu ein Video auf.</p></section>;
 return <div className="video-editor">
  <div className="section-heading large"><div><p className="eyebrow">DEIN VIDEOSTUDIO</p><h1>Videoeditor<span>.</span></h1><p>Wähle eine Aufnahme, setze Anfang und Ende und speichere deinen Schnitt.</p></div></div>
  <div className="editor-layout">
   <section className="panel editor-source" aria-label="Aufnahme auswählen">
    <div className="editor-section-title"><div><p className="eyebrow">01 / AUSGANGSMATERIAL</p><h2>Dein Material</h2></div><Clapperboard size={20}/></div>
    <label>Projekt<select value={projectId} disabled={working||refreshing} onChange={e=>setProjectId(e.target.value)}>{projects.map(project=><option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
    <label>Aufnahme<select value={recordingId} disabled={working||refreshing||!recordings?.length} onChange={e=>{setRecordingId(e.target.value);setDuration(0);setNotice('');setError('');}}>{!recordings?.length&&<option value="">{recordings===null?'Wird geladen …':'Keine Aufnahme vorhanden'}</option>}{recordings?.map(recording=><option key={recording.id} value={recording.id}>{date(recording.created_at)} · {recording.mime==='video/mp4'?'MP4':'WebM'} · {(recording.size/1024/1024).toFixed(1)} MB</option>)}</select></label>
    <button type="button" className="secondary-action" disabled={working||refreshing||!projectId} onClick={()=>void refresh()}>{refreshing?'Aktualisiert …':'Aufnahmen aktualisieren'}</button>
    {source?<video key={source} ref={video} className="editor-video" src={source} controls playsInline preload="metadata" aria-label="Aufnahme im Videoeditor"
     onLoadStart={()=>{if(probeTimer.current)clearTimeout(probeTimer.current);probeTimer.current=null;probingDuration.current=false;durationInitialized.current=false;setDuration(0);setPosition(0);setDurationNotice('');setPreviewing(false);}}
     onError={()=>{if(probeTimer.current)clearTimeout(probeTimer.current);probeTimer.current=null;probingDuration.current=false;setDuration(0);setPosition(0);setPreviewing(false);setDurationNotice('');setError('Die Aufnahme konnte nicht abgespielt werden.');}}
     onLoadedMetadata={event=>readDuration(event.currentTarget)}
     onDurationChange={event=>{if(event.currentTarget.readyState>=1&&Number.isFinite(event.currentTarget.duration))updateDuration(event.currentTarget,event.currentTarget.duration);}}
     onSeeked={event=>{const el=event.currentTarget;if(probingDuration.current){const candidate=Number.isFinite(el.duration)?el.duration:el.currentTime;if(candidate>0&&candidate<1e9)updateDuration(el,candidate);}else if(Number.isFinite(el.currentTime))setPosition(el.currentTime);}}
     onTimeUpdate={event=>{const el=event.currentTarget;if(!probingDuration.current&&Number.isFinite(el.currentTime))setPosition(el.currentTime);if(previewing&&el.currentTime>=end){el.pause();setPreviewing(false);}}}
     onPause={()=>setPreviewing(false)} onEnded={()=>setPreviewing(false)}/>:<div className="editor-no-video">{recordings===null?'Aufnahmen werden geladen …':'Noch keine Aufnahme für dieses Projekt.'}</div>}
    {durationNotice&&<p role="status">{durationNotice}</p>}
   </section>
   <section className="panel editor-controls" aria-label="Video schneiden">
    <div className="editor-section-title"><div><p className="eyebrow">02 / SCHNITT</p><h2>Dein Ausschnitt</h2></div><Scissors size={20}/></div>
    <p>Spiele die Aufnahme ab und setze die Schnittmarken an der aktuellen Position. Du kannst die Zeiten auch über die Regler oder direkt in Sekunden ändern.</p>
    <p className="editor-position">Aktuelle Position: <strong>{duration>0?seconds(position):'–:–'}</strong></p>
    <div className="editor-mark-actions" aria-label="Schnittmarken an der aktuellen Position setzen">
     <button type="button" className="secondary-action" disabled={!source||!duration||working||refreshing} onClick={()=>markPosition('start')}>Anfang hier setzen</button>
     <button type="button" className="secondary-action" disabled={!source||!duration||working||refreshing} onClick={()=>markPosition('end')}>Ende hier setzen</button>
    </div>
    <p>Der Ausschnitt muss mindestens 0,1 Sekunden und darf bis zu zehn Minuten lang sein.</p>
    <label htmlFor="trim-start">Anfang <strong>{seconds(start)}</strong></label>
    <input id="trim-start" type="range" min={0} max={duration||1} step="0.01" disabled={!duration||working||refreshing} aria-describedby="trim-range-status" aria-valuetext={seconds(start)} value={Number.isFinite(start)?Math.max(0,Math.min(start,duration||1)):0} onChange={e=>setStart(Number(e.target.value))}/>
    <input aria-label="Anfang in Sekunden" aria-describedby="trim-range-status" aria-invalid={duration>0&&!valid} type="number" min="0" max={duration||undefined} step="0.001" disabled={!duration||working||refreshing} value={Number.isFinite(start)?start:''} onChange={e=>setStart(e.target.valueAsNumber)}/>
    <label htmlFor="trim-end">Ende <strong>{seconds(end)}</strong></label>
    <input id="trim-end" type="range" min={0} max={duration||1} step="0.01" disabled={!duration||working||refreshing} aria-describedby="trim-range-status" aria-valuetext={seconds(end)} value={Number.isFinite(end)?Math.max(0,Math.min(end,duration||1)):0} onChange={e=>setEnd(Number(e.target.value))}/>
    <input aria-label="Ende in Sekunden" aria-describedby="trim-range-status" aria-invalid={duration>0&&!valid} type="number" min="0" max={duration||undefined} step="0.001" disabled={!duration||working||refreshing} value={Number.isFinite(end)?end:''} onChange={e=>setEnd(e.target.valueAsNumber)}/>
    <p className="editor-duration" id="trim-range-status" aria-live="polite">Ausschnitt: <strong>{valid?seconds(end-start):duration>0&&duration<MIN_TRIM_SECONDS?'Aufnahme ist kürzer als 0,1 Sekunden':'Bitte gültigen Bereich wählen'}</strong>{duration>0&&` · Gesamtlänge ${seconds(duration)}`}</p>
    <button type="button" className="secondary-action" disabled={!valid||working||refreshing} onClick={playRange}><Play size={16}/> Ausschnitt ansehen</button>
    <button type="button" className="primary" disabled={!valid||working||refreshing} onClick={()=>void render()}><Scissors size={16}/>{working?'Video wird geschnitten …':'Schnitt speichern'}</button>
    {working&&<p role="status">Die Verarbeitung läuft auf dem Server und kann einige Minuten dauern.</p>}
    {notice&&<p className="editor-success" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
    {source&&<a className="editor-download" href={`${source}?download=1`}><Download size={16}/> Aktuelle Aufnahme herunterladen</a>}
    <p className="editor-hint">Der Schnitt wird als neue MP4-Aufnahme beim Projekt gespeichert. Das Original bleibt erhalten. Mehrspurschnitt und KI-Schnitt folgen.</p>
   </section>
  </div>
 </div>;
}
