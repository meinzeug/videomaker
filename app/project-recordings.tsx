'use client';
import { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, Video } from 'lucide-react';

type Recording={id:string;created_at:string;mime:string;size:number};
export default function ProjectRecordings({projectId}:{projectId:string}) {
 const [recordings,setRecordings]=useState<Recording[]|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [deleting,setDeleting]=useState('');
 const url=`/api/projects/${encodeURIComponent(projectId)}/recordings`;
 const load=useCallback(async()=>{const response=await fetch(url,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Aufnahmen konnten nicht geladen werden.');return data.recordings as Recording[];},[url]);
 useEffect(()=>{let active=true;setRecordings(null);setError('');load().then(items=>{if(active)setRecordings(items);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Aufnahmen konnten nicht geladen werden.');});return()=>{active=false;};},[load]);
 async function remove(item:Recording){if(!confirm('Diese Aufnahme dauerhaft vom Server löschen?'))return;setDeleting(item.id);setError('');setNotice('');try{const response=await fetch(`${url}/${encodeURIComponent(item.id)}`,{method:'DELETE'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Löschen fehlgeschlagen.');if(result.cleanupPending)setNotice('Einige bereits gelöschte Aufnahmedateien werden im Hintergrund weiter entfernt.');setRecordings(items=>items?.filter(x=>x.id!==item.id)||[]);}catch(e){setError(e instanceof Error?e.message:'Löschen fehlgeschlagen.');}finally{setDeleting('');}}
 return <section className="visual-section recordings-section" aria-label="Aufnahmen zum Skript">
  <div className="visual-heading"><div><p className="eyebrow">VIDEO & TON</p><h2>Deine Aufnahmen<span>.</span></h2><p>Alle Videos, die du mit diesem Skript aufgenommen hast.</p></div></div>
  {error&&<p className="visual-message visual-error" role="alert">{error}</p>}
  {notice&&<p className="visual-message" role="status">{notice}</p>}
  {recordings===null&&!error&&<p className="visual-message">Aufnahmen werden geladen …</p>}
  {recordings?.length===0&&<div className="visual-empty"><Video size={24}/><span>Noch keine Aufnahmen. Starte eine Aufnahme im Teleprompter.</span></div>}
  {!!recordings?.length&&<div className="recordings-grid">{recordings.map(item=>{const src=`${url}/${encodeURIComponent(item.id)}`;const date=new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(item.created_at));return <article className="visual-asset recording-asset" key={item.id}><video src={src} controls preload="metadata" playsInline aria-label={`Aufnahme vom ${date}`}/><div className="visual-info"><div><small>AUFNAHME · {date}</small><b>{item.mime==='video/mp4'?'MP4':'WEBM'} · {(item.size/1024/1024).toFixed(1)} MB</b></div><div className="recording-actions"><a className="visual-download" href={`${src}?download=1`} aria-label={`Aufnahme vom ${date} herunterladen`}><Download size={17}/><span>Download</span></a><button className="icon delete" disabled={!!deleting} onClick={()=>remove(item)} aria-label={`Aufnahme vom ${date} löschen`}><Trash2 size={17}/></button></div></div></article>;})}</div>}
 </section>;
}
