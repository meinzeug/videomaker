'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Download, Square, VideoOff } from 'lucide-react';

type Phase = 'idle' | 'permission' | 'ready' | 'recording' | 'stopping' | 'review';
type Props = { projectId:string; onRecordingChange: (recording: boolean) => void; onGuardChange: (guarded: boolean) => void };
type Clip={url:string;extension:string;size:number;data:Blob;id:string};

function deviceError(error: unknown) {
 const name = error instanceof Error ? error.name : '';
 if (name === 'NotAllowedError' || name === 'SecurityError') return 'Kamera- oder Mikrofonzugriff wurde verweigert. Bitte die Browserberechtigungen prüfen.';
 if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Kamera oder Mikrofon wurde nicht gefunden. Bitte beide Geräte anschließen und erneut versuchen.';
 if (name === 'NotReadableError' || name === 'AbortError') return 'Kamera oder Mikrofon ist nicht verfügbar. Möglicherweise wird das Gerät bereits verwendet.';
 return 'Kamera und Mikrofon konnten nicht geöffnet werden. Bitte Geräte und Browserberechtigungen prüfen.';
}
function formatTime(seconds: number) { const minutes=Math.floor(seconds/60), remainder=seconds%60; return `${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`; }
function preferredMime() {
 if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
 return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type)) || '';
}

export default function Recorder({projectId,onRecordingChange,onGuardChange}:Props) {
 const [phase,setPhase]=useState<Phase>('idle');
 const [error,setError]=useState('');
 const [clip,setClip]=useState<Clip|null>(null);
 const [downloaded,setDownloaded]=useState(false);
 const [saveState,setSaveState]=useState<'idle'|'uploading'|'saved'|'error'>('idle');
 const [progress,setProgress]=useState(0);
 const [elapsed,setElapsed]=useState(0);
 const [previewStream,setPreviewStream]=useState<MediaStream|null>(null);
 const preview=useRef<HTMLVideoElement>(null);
 const stream=useRef<MediaStream|null>(null);
 const recorder=useRef<MediaRecorder|null>(null);
 const chunks=useRef<Blob[]>([]);
 const mounted=useRef(false);
 const requesting=useRef(false);
 const requestVersion=useRef(0);
 const clipUrl=useRef<string|null>(null);
 const recorderError=useRef('');
 const startedAt=useRef(0);
 const upload=useRef<XMLHttpRequest|null>(null);
 const guarded=phase==='recording'||phase==='stopping'||saveState==='uploading'||(!!clip&&saveState!=='saved'&&!downloaded);

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestVersion.current++;upload.current?.abort();if(recorder.current&&recorder.current.state!=='inactive')recorder.current.stop();stream.current?.getTracks().forEach(track=>track.stop());if(clipUrl.current)URL.revokeObjectURL(clipUrl.current);};},[]);
 useEffect(()=>{onGuardChange(guarded);return()=>onGuardChange(false);},[guarded,onGuardChange]);
 useEffect(()=>{if(!guarded)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[guarded]);
 useEffect(()=>{if(preview.current){preview.current.srcObject=previewStream;if(previewStream)void preview.current.play().catch(()=>{});}},[previewStream,phase]);
 useEffect(()=>{if(phase!=='recording')return;const update=()=>setElapsed(Math.max(0,Math.floor((performance.now()-startedAt.current)/1000)));update();const interval=setInterval(update,250);return()=>clearInterval(interval);},[phase]);

 function stopDevices() {stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;setPreviewStream(null);}
 function save(item:Clip,warning='') {
  if(item.size>1024*1024*1024){setSaveState('error');setError('Die Aufnahme überschreitet das Serverlimit von 1 GB. Bitte lade sie auf dein Gerät herunter.');return;}
  setSaveState('uploading');setProgress(0);setError(warning);
  const request=new XMLHttpRequest();upload.current=request;
  request.open('POST',`/api/projects/${encodeURIComponent(projectId)}/recordings`);
  request.setRequestHeader('Content-Type',item.extension==='mp4'?'video/mp4':'video/webm');
  request.setRequestHeader('X-Recording-Id',item.id);
  request.upload.onprogress=event=>{if(mounted.current&&event.lengthComputable)setProgress(Math.round(event.loaded/event.total*100));};
  request.onload=()=>{if(!mounted.current)return;upload.current=null;if(request.status>=200&&request.status<300){setSaveState('saved');setProgress(100);}else{let message='Speichern fehlgeschlagen. Bitte erneut versuchen.';try{message=JSON.parse(request.responseText).error||message;}catch{}setError(message);setSaveState('error');}};
  request.onerror=()=>{if(mounted.current){upload.current=null;setSaveState('error');setError('Verbindung unterbrochen. Bitte Speichern erneut versuchen oder die Aufnahme herunterladen.');}};
  request.send(item.data);
 }
 async function prepare() {
  if(requesting.current)return;
  if(!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==='undefined'){setError('Dieser Browser unterstützt die Aufnahme hier nicht. Bitte eine aktuelle Version von Chrome, Edge, Firefox oder Safari über HTTPS verwenden.');return;}
  requesting.current=true;const version=++requestVersion.current;setError('');setPhase('permission');
  try {
   const media=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'},audio:true});
   if(!mounted.current||version!==requestVersion.current){media.getTracks().forEach(track=>track.stop());return;}
   if(!media.getVideoTracks().length||!media.getAudioTracks().length){media.getTracks().forEach(track=>track.stop());throw new DOMException('Kamera oder Mikrofon fehlt','NotFoundError');}
   stream.current=media;setPreviewStream(media);setPhase('ready');
   for(const track of media.getTracks()) track.addEventListener('ended',()=>{
    if(!mounted.current||stream.current!==media)return;
    recorderError.current='Kamera oder Mikrofon wurde während der Aufnahme getrennt.';
    if(recorder.current && recorder.current.state!=='inactive'){setPhase('stopping');recorder.current.stop();}
    else {stopDevices();setError('Kamera oder Mikrofon wurde getrennt. Bitte erneut verbinden.');setPhase('idle');}
   },{once:true});
  } catch(e) {if(mounted.current&&version===requestVersion.current){setError(deviceError(e));setPhase('idle');}}
  finally {requesting.current=false;}
 }
 function start() {
  const media=stream.current;if(!media||media.getVideoTracks().some(t=>t.readyState!=='live')||media.getAudioTracks().some(t=>t.readyState!=='live')){setError('Kamera oder Mikrofon ist nicht mehr verfügbar. Bitte erneut vorbereiten.');stopDevices();setPhase('idle');return;}
  try {
   const type=preferredMime();const instance=type?new MediaRecorder(media,{mimeType:type}):new MediaRecorder(media);
   recorder.current=instance;chunks.current=[];recorderError.current='';
   instance.ondataavailable=event=>{if(event.data.size)chunks.current.push(event.data);};
   instance.onerror=()=>{recorderError.current='Die Aufnahme wurde durch einen Browser- oder Gerätefehler unterbrochen. Prüfe die Datei vor der Verwendung.';};
   instance.onstop=()=>{
    if(!mounted.current)return;
    onRecordingChange(false);stopDevices();recorder.current=null;
    const mime=instance.mimeType || chunks.current[0]?.type || 'video/webm';
    const data=new Blob(chunks.current,{type:mime});chunks.current=[];
    if(data.size===0){setError(recorderError.current||'Die Aufnahme enthält keine Daten. Bitte erneut versuchen.');setPhase('idle');return;}
    if(clipUrl.current)URL.revokeObjectURL(clipUrl.current);
    const url=URL.createObjectURL(data);clipUrl.current=url;
    const item={url,extension:mime.toLowerCase().includes('mp4')?'mp4':'webm',size:data.size,data,id:crypto.randomUUID()};
    setClip(item);setDownloaded(false);setPhase('review');save(item,recorderError.current);
   };
   instance.start(1000);startedAt.current=performance.now();setElapsed(0);setPhase('recording');onRecordingChange(true);
  } catch {recorder.current=null;setError('Die Aufnahme konnte nicht gestartet werden. Bitte einen anderen Browser oder andere Geräte versuchen.');stopDevices();setPhase('idle');}
 }
 function stop(){const instance=recorder.current;if(!instance||instance.state==='inactive')return;setPhase('stopping');instance.stop();}
 function discard(){if(clipUrl.current)URL.revokeObjectURL(clipUrl.current);clipUrl.current=null;setClip(null);setDownloaded(false);setSaveState('idle');setProgress(0);setError('');setElapsed(0);setPhase('idle');}
 const filename=`kontrakurs-aufnahme-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.${clip?.extension || 'webm'}`;
 return <section className="recorder" aria-label="Videoaufnahme">
  <div className="recorder-heading"><div><p className="eyebrow">KAMERA & MIKROFON</p><h2>Aufnahme<span>.</span></h2></div>{phase==='recording'&&<span className="recording-indicator" role="status"><span/> AUFNAHME {formatTime(elapsed)}</span>}</div>
  {(phase==='ready'||phase==='recording'||phase==='stopping')&&<div className="recorder-preview"><video ref={preview} autoPlay muted playsInline aria-label="Kameravorschau"/><span className="preview-label">LIVE-VORSCHAU</span></div>}
  {phase==='review'&&clip&&<div className="recorder-preview"><video src={clip.url} controls playsInline aria-label="Aufnahme abspielen"/><span className="preview-label">DEINE AUFNAHME</span></div>}
  {(phase==='idle'||phase==='permission')&&<div className="recorder-empty"><Camera size={23}/><p>Mit Kamera und Mikrofon aufnehmen, während dein Skript läuft.</p></div>}
  {error&&<p className="recorder-error" role="alert">{error}</p>}
  {(phase==='idle'||phase==='permission')&&<button className="recorder-secondary" disabled={phase==='permission'} onClick={prepare}><Camera size={16}/>{phase==='permission'?'Warte auf Freigabe …':'Kamera & Mikrofon vorbereiten'}</button>}
  {phase==='ready'&&<><button className="record-button" onClick={start}><span/>Aufnahme starten</button><button className="recorder-text-button" onClick={()=>{stopDevices();setPhase('idle');}}><VideoOff size={15}/> Geräte ausschalten</button></>}
  {(phase==='recording'||phase==='stopping')&&<button className="record-button stop" disabled={phase==='stopping'} onClick={stop}><Square size={15} fill="currentColor"/>{phase==='stopping'?'Aufnahme wird verarbeitet …':`Aufnahme stoppen · ${formatTime(elapsed)}`}</button>}
  {phase==='review'&&clip&&<><p className="recorder-save-status" role="status">{saveState==='uploading'?`Auf Server speichern … ${progress} %`:saveState==='saved'?'Aufnahme beim Skript gespeichert.':saveState==='error'?'Noch nicht auf dem Server gespeichert.':''}</p>{saveState==='error'&&<button className="recorder-secondary" onClick={()=>save(clip)}>Speichern erneut versuchen</button>}<a className="record-button download-recording" href={clip.url} download={filename} onClick={()=>setDownloaded(true)}><Download size={16}/> Aufnahme herunterladen</a><button className="recorder-text-button" disabled={saveState==='uploading'} onClick={discard}>{saveState==='saved'||downloaded?'Neue Aufnahme':'Aufnahme verwerfen'}</button><p className="recorder-note">Format: {clip.extension.toUpperCase()} · {(clip.size/1024/1024).toFixed(1)} MB</p></>}
  {phase!=='review'&&<p className="recorder-note">Aufnahmen werden beim Skript auf dem Server gespeichert (max. 1 GB pro Aufnahme). Kamera und Mikrofon benötigen deine Freigabe.</p>}
 </section>;
}
