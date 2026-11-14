'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {cameraStartWasRefused} from '@/lib/camera-ui-state';
import CameraPreview from './camera-preview';

type Camera={id:string;name:string;phase:'idle'|'preparing'|'recording'|'finalizing'|'ready'|'partial'|'error';recordingId:string|null;projectId:string|null;pendingStart:boolean;lastCommand:{id:string;result:string;neverDelivered?:number|boolean}|null;recoverableClaim:{recordingId:string;projectId:string;phase:'partial'|'error'}|null;stopIntent:{id:string;recordingId:string;observed:boolean}|null};
type Command={id:string;type:'record_start'|'record_stop';recordingId:string;projectId?:string;deviceId:string};
const labels:Record<Camera['phase'],string>={idle:'Aufnahmebereit',preparing:'Aufnahme wird vorbereitet',recording:'Aufnahme läuft',finalizing:'Aufnahme wird abgeschlossen',ready:'Lokal gespeichert',partial:'Lokal unvollständig gespeichert',error:'Kamera meldet einen Fehler'};

/** Appears only when the internal camera API is enabled; production remains 404. */
export default function CameraDeviceControl({projectId}:{projectId:string}){
 const [available,setAvailable]=useState(false),[cameras,setCameras]=useState<Camera[]>([]),[selected,setSelected]=useState(''),[loading,setLoading]=useState(false),[pending,setPending]=useState<Command|null>(null),[message,setMessage]=useState(''),[connectionError,setConnectionError]=useState(false);
 const [preview,setPreview]=useState<{generation:string;creationToken:string;devices:{deviceId:string;available:boolean}[]}|null>(null);
 const refreshSequence=useRef(0);
 const refresh=useCallback(async()=>{const revision=++refreshSequence.current,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1800);try{
  const response=await fetch('/api/camera-devices',{cache:'no-store',signal:controller.signal});if(revision!==refreshSequence.current)return;if(response.status===404){setAvailable(false);return;}if(!response.ok)throw Error();
  const data=await response.json();if(revision!==refreshSequence.current)return;setAvailable(true);setCameras(data.devices);setConnectionError(false);
  setPending(previous=>{if(!previous)return null;const camera=(data.devices as Camera[]).find(item=>item.id===previous.deviceId);if(!camera)return previous;
   if(previous.type==='record_start'&&camera.recordingId===previous.recordingId&&camera.phase!=='idle')return null;
   if(previous.type==='record_start'&&cameraStartWasRefused(camera.lastCommand,previous.id))return null;
   if(previous.type==='record_stop'&&camera.stopIntent?.recordingId===previous.recordingId&&camera.stopIntent.observed)return null;
   return previous;});
 }catch{if(revision===refreshSequence.current)setConnectionError(true);}finally{clearTimeout(timeout);}},[]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{clearInterval(timer);refreshSequence.current++;};},[refresh]);
 useEffect(()=>{if(!pending)setMessage(previous=>previous.startsWith('Start angefragt.')||previous.startsWith('Stopp angefragt.')?'':previous);},[pending]);
 const camera=cameras.find(item=>item.id===selected);
 useEffect(()=>{
  if(!available||!camera){setPreview(null);return;}
  let active=true,revision=0;const load=async()=>{const current=++revision,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1800);try{const response=await fetch('/api/camera-preview/devices',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();const data=await response.json();if(!data||typeof data.generation!=='string'||typeof data.creationToken!=='string'||!Array.isArray(data.devices))throw Error();if(active&&current===revision)setPreview(data);}catch{if(active&&current===revision)setPreview(null);}finally{clearTimeout(timeout);}};
  void load();const timer=setInterval(()=>void load(),2000);return()=>{active=false;clearInterval(timer);};
 },[available,selected,!!camera]);
 async function send(command:Command){
  setPending(command);setLoading(true);setMessage('Anfrage wird gesendet. Der Zustand der Kamera ist maßgeblich.');
  try{
   const {deviceId,...body}=command;const response=await fetch(`/api/camera-devices/${encodeURIComponent(deviceId)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();
   if(!response.ok){setMessage(data.error||'Die Anfrage wurde nicht angenommen.');if(response.status>=400&&response.status<500)setPending(null);return;}
   setMessage(command.type==='record_start'?'Start angefragt. Warte auf die Kamerabestätigung.':'Stopp angefragt. Warte auf die Kamerabestätigung.');
   await refresh();
  }catch{setMessage('Keine Bestätigung erhalten. Bitte Kamera prüfen oder dieselbe Anfrage erneut senden.');}
  finally{setLoading(false);}
 }
 async function resolveFailure(){
  const claim=camera?.recoverableClaim;if(!camera||!claim||claim.projectId!==projectId)return;
  if(!window.confirm('Die Aufnahme ist fehlgeschlagen oder unvollständig. Bitte sichere eine eventuell vorhandene Datei zuerst am Smartphone. Die lokale Datei bleibt erhalten. Danach darf dieses Skript gelöscht werden. Möchtest du die Sperre auflösen?'))return;
  setLoading(true);try{const response=await fetch(`/api/camera-devices/${encodeURIComponent(camera.id)}/resolve`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordingId:claim.recordingId,projectId:claim.projectId,confirm:'retain-local-file'})});const data=await response.json();if(!response.ok)throw Error(data.error||'Die Sperre konnte nicht aufgelöst werden.');setMessage('Die Sperre wurde nach deiner Bestätigung aufgelöst. Die lokale Datei wurde nicht gelöscht.');await refresh();}catch(error){setMessage(error instanceof Error?error.message:'Die Sperre konnte nicht aufgelöst werden.');}finally{setLoading(false);}
 }
 if(!available)return null;
 return <section className="panel device-control" aria-label="Smartphone-Kamera">
  <p className="eyebrow">SMARTPHONE-KAMERA</p><h2>Kamera steuern</h2>
  <p>Die Aufnahme entsteht auf dem Smartphone. Eine Cloud-Speicherung ist erst nach überprüftem Upload bestätigt.</p>
  <label>Kamera <select value={camera?selected:''} disabled={!!pending} onChange={event=>setSelected(event.target.value)}><option value="">Gerät auswählen</option>{cameras.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  {!cameras.length&&<p>Keine Kamera erreichbar.</p>}{connectionError&&<p role="alert">Verbindung unterbrochen. Den Aufnahmezustand bitte am Smartphone prüfen.</p>}
  {camera&&<p role="status"><strong>{labels[camera.phase]}</strong>{camera.phase==='ready'&&' – der Upload ist damit noch nicht bestätigt.'}{camera.projectId&&camera.projectId!==projectId&&' · Anderes Skript'}</p>}
  {camera?.lastCommand&&cameraStartWasRefused(camera.lastCommand,camera.lastCommand.id)&&<p role="alert">Die letzte Startanfrage wurde nicht ausgeführt. Bitte den Kamerastatus prüfen.</p>}
  {camera?.recoverableClaim?.projectId===projectId&&<p>Für dieses Skript liegt eine fehlgeschlagene oder unvollständige Aufnahme vor. Eine lokale Datei kann am Smartphone gesichert werden.</p>}
  <div className="device-actions"><button className="primary" disabled={!camera||camera.phase!=='idle'||camera.pendingStart||!!pending||loading||connectionError} onClick={()=>camera&&void send({id:crypto.randomUUID(),type:'record_start',recordingId:crypto.randomUUID(),projectId,deviceId:camera.id})}>Aufnahme starten</button>
   <button className="secondary-action" disabled={!camera||!camera.recordingId||!['preparing','recording'].includes(camera.phase)||!!pending||loading||connectionError} onClick={()=>camera?.recordingId&&void send({id:crypto.randomUUID(),type:'record_stop',recordingId:camera.recordingId,deviceId:camera.id})}>Aufnahme stoppen</button>
   {pending&&<button className="secondary-action" disabled={loading||connectionError} onClick={()=>void send(pending)}>Anfrage erneut senden</button>}
   {camera?.recoverableClaim?.projectId===projectId&&<button className="secondary-action" disabled={loading||connectionError||!!pending||!['idle','error','partial'].includes(camera.phase)} onClick={()=>void resolveFailure()}>Aufnahmesperre auflösen</button>}</div>
  {camera&&preview&&<CameraPreview deviceId={camera.id} generation={preview.generation} creationToken={preview.creationToken} available={preview.devices.some(item=>item.deviceId===camera.id&&item.available)}/>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
