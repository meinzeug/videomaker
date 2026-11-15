'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {cameraStartWasRefused} from '@/lib/camera-ui-state';
import {beginCameraUiAttempt,cameraUiAttemptIsCurrent,cameraHttpOutcome,cameraUiMayStop,cameraControlAvailability,cameraControlCompletion,cameraControlUnsettled,type CameraUiAttempt,type CameraUiCommand} from './camera-panel-policy';
import CameraPreview from './camera-preview';
import CameraPanelControls from './camera-panel-controls';
import CameraRecovery from './camera-recovery';

type Camera={id:string;name:string;phase:'idle'|'preparing'|'recording'|'finalizing'|'ready'|'partial'|'error';recordingId:string|null;projectId:string|null;pendingStart:boolean;uncertain:boolean;capability?:string|null;paused?:boolean|null;cameraFront?:boolean|null;cameraCanSwitch?:boolean;lastControl?:{id:string;type:string;recordingId:string;result:string;cameraFrom?:boolean|null}|null;lastCommand:{id:string;result:string;receiptCapability?:string|null;neverDelivered?:number|boolean}|null;recoverableClaim:{recordingId:string;projectId:string;phase:'partial'|'error'}|null;stopIntent:{id:string;recordingId:string;observed:boolean}|null};
type Command=CameraUiCommand;
type OpenClaim={recordingId:string;deviceId:string;deviceName:string|null;openedAt:number;lastConfirmedPhase:'ready'|'partial'|'error'|'unknown';recovery:{sizeBytes:number;sha256:string}|null};
const labels:Record<Camera['phase'],string>={idle:'Aufnahmebereit',preparing:'Aufnahme wird vorbereitet',recording:'Aufnahme läuft',finalizing:'Aufnahme wird abgeschlossen',ready:'Lokal gespeichert',partial:'Lokal unvollständig gespeichert',error:'Kamera meldet einen Fehler'};

/** Appears only when the internal camera API is enabled; production remains 404. */
export default function CameraDeviceControl({projectId}:{projectId:string}){
 const [available,setAvailable]=useState(false),[cameras,setCameras]=useState<Camera[]>([]),[selected,setSelected]=useState(''),[loading,setLoading]=useState(false),[pending,setPending]=useState<Command|null>(null),[message,setMessage]=useState(''),[connectionError,setConnectionError]=useState(false);
 const [preview,setPreview]=useState<{generation:string;creationToken:string;devices:{deviceId:string;available:boolean}[]}|null>(null);
 const [openClaims,setOpenClaims]=useState<{projectId:string;claims:OpenClaim[];hasMore:boolean}|null>(null),[claimsError,setClaimsError]=useState(false);
 const [recovering,setRecovering]=useState<string|null>(null),recoveringRef=useRef<string|null>(null);
 const refreshSequence=useRef(0),commandAttempt=useRef<CameraUiAttempt|null>(null),messageRevision=useRef(0);
 const [inFlightCommand,setInFlightCommand]=useState<Command|null>(null);
 const refresh=useCallback(async()=>{const revision=++refreshSequence.current,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1800);try{
  const response=await fetch('/api/camera-devices',{cache:'no-store',signal:controller.signal});if(revision!==refreshSequence.current)return;if(response.status===404){setAvailable(false);setConnectionError(false);return;}if(!response.ok)throw Error();
  const data=await response.json();if(revision!==refreshSequence.current)return;setAvailable(true);setCameras(data.devices);setConnectionError(false);
  setPending(previous=>{if(!previous)return null;const camera=(data.devices as Camera[]).find(item=>item.id===previous.deviceId);if(!camera)return previous;
   if(previous.type==='record_start'&&camera.recordingId===previous.recordingId&&camera.phase!=='idle')return null;
   if(previous.type==='record_start'&&cameraStartWasRefused(camera.lastCommand,previous.id))return null;
   if(previous.type==='record_stop'&&camera.stopIntent?.recordingId===previous.recordingId&&camera.stopIntent.observed)return null;
   if(['record_pause','record_resume','camera_switch'].includes(previous.type)&&cameraControlCompletion(camera,previous)!=='pending')return null;
   return previous;});
 }catch{if(revision===refreshSequence.current)setConnectionError(true);}finally{clearTimeout(timeout);}},[]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{clearInterval(timer);refreshSequence.current++;};},[refresh]);
 useEffect(()=>{if(!pending)setMessage(previous=>['Start angefragt.','Stopp angefragt.','Pause angefragt.','Fortsetzen angefragt.','Kamerawechsel angefragt.'].some(prefix=>previous.startsWith(prefix))?'':previous);},[pending]);
 const camera=cameras.find(item=>item.id===selected);
 const controls=cameraControlAvailability(camera,projectId,!!pending||loading||!!inFlightCommand,connectionError);
 useEffect(()=>{
  setOpenClaims(null);setClaimsError(false);
  if(!available)return;
  let active=true,revision=0;
  const load=async()=>{const current=++revision,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1800);try{
   const response=await fetch(`/api/camera-devices/claims?projectId=${encodeURIComponent(projectId)}`,{cache:'no-store',signal:controller.signal});
   if(!response.ok)throw Error();const data=await response.json();
   if(!data||!Array.isArray(data.claims)||typeof data.hasMore!=='boolean')throw Error();
   if(active&&current===revision&&!recoveringRef.current){setOpenClaims({projectId,claims:data.claims,hasMore:data.hasMore});setClaimsError(false);}
  }catch{if(active&&current===revision&&!recoveringRef.current){setOpenClaims(null);setClaimsError(true);}}finally{clearTimeout(timeout);}};
  void load();const timer=setInterval(()=>void load(),5000);return()=>{active=false;clearInterval(timer);};
 },[available,projectId]);
 useEffect(()=>{
  if(!available||!camera){setPreview(null);return;}
  let active=true,revision=0;const load=async()=>{const current=++revision,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1800);try{const response=await fetch('/api/camera-preview/devices',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();const data=await response.json();if(!data||typeof data.generation!=='string'||typeof data.creationToken!=='string'||!Array.isArray(data.devices))throw Error();if(active&&current===revision)setPreview(data);}catch{if(active&&current===revision)setPreview(null);}finally{clearTimeout(timeout);}};
  void load();const timer=setInterval(()=>void load(),2000);return()=>{active=false;clearInterval(timer);};
 },[available,selected,!!camera]);
 async function send(command:Command){
  // The take comes from the last observed camera, never from an unconfirmed start.
  if(command.type==='record_stop'&&!cameraUiMayStop(camera,command))return;
  if(command.type==='record_start'&&(!camera||command.deviceId!==camera.id||command.projectId!==projectId||camera.capability!=='remote-record-v4'||camera.uncertain!==false||camera.phase!=='idle'||camera.pendingStart||cameraControlUnsettled(camera)||connectionError)){setMessage('Kamera ist nicht sicher aufnahmebereit. Bitte den Zustand am Smartphone prüfen.');return;}
  if(command.type==='record_pause'&&(command.expectedProjectId!==projectId||command.deviceId!==camera?.id||command.recordingId!==camera?.recordingId||!cameraControlAvailability(camera,projectId,false,connectionError).pause)){setMessage('Aufnahmezustand hat sich geändert. Bitte am Smartphone prüfen.');return;}
  if(command.type==='record_resume'&&(command.expectedProjectId!==projectId||command.deviceId!==camera?.id||command.recordingId!==camera?.recordingId||!cameraControlAvailability(camera,projectId,false,connectionError).resume)){setMessage('Aufnahmezustand hat sich geändert. Bitte am Smartphone prüfen.');return;}
  if(command.type==='camera_switch'&&(command.deviceId!==camera?.id||!cameraControlAvailability(camera,projectId,false,connectionError).switchCamera||camera?.cameraFront!==command.cameraFrom)){setMessage('Kamerazustand hat sich geändert. Bitte am Smartphone prüfen.');return;}
  const attempt=beginCameraUiAttempt(commandAttempt.current,command);if(!attempt)return;
  commandAttempt.current=attempt;messageRevision.current++;setInFlightCommand(command);setPending(command);
  setMessage('Anfrage wird gesendet. Der Zustand der Kamera ist maßgeblich.');
  try{
   const {deviceId,expectedProjectId: _expectedProjectId,...body}=command;const response=await fetch(`/api/camera-devices/${encodeURIComponent(deviceId)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();
   if(!cameraUiAttemptIsCurrent(commandAttempt.current,attempt))return;
   if(cameraHttpOutcome(response.ok)==='uncertain'){setMessage('Keine verlässliche Bestätigung. Bitte den Zustand am Smartphone prüfen.');return;}
   const label={record_start:'Start',record_stop:'Stopp',record_pause:'Pause',record_resume:'Fortsetzen',camera_switch:'Kamerawechsel'}[command.type];
   setMessage(`${label} angefragt. Warte auf den bestätigten Kamerazustand.`);
   await refresh();
  }catch{if(cameraUiAttemptIsCurrent(commandAttempt.current,attempt))setMessage('Keine Bestätigung erhalten. Bitte Kamera prüfen oder dieselbe Anfrage erneut senden.');}
  finally{if(cameraUiAttemptIsCurrent(commandAttempt.current,attempt)){commandAttempt.current=null;setInFlightCommand(null);}}
 }
 async function resolveFailure(){
  const claim=camera?.recoverableClaim;if(!camera||!claim||claim.projectId!==projectId)return;
  if(!window.confirm('Die Aufnahme ist fehlgeschlagen oder unvollständig. Bitte sichere eine eventuell vorhandene Datei zuerst am Smartphone. Die lokale Datei bleibt erhalten. Danach darf dieses Skript gelöscht werden. Möchtest du die Sperre auflösen?'))return;
  const revision=++messageRevision.current;setLoading(true);try{const response=await fetch(`/api/camera-devices/${encodeURIComponent(camera.id)}/resolve`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordingId:claim.recordingId,projectId:claim.projectId,confirm:'retain-local-file'})});const data=await response.json();if(!response.ok)throw Error(data.error||'Die Sperre konnte nicht aufgelöst werden.');if(revision===messageRevision.current)setMessage('Die Sperre wurde nach deiner Bestätigung aufgelöst. Die lokale Datei wurde nicht gelöscht.');await refresh();}catch(error){if(revision===messageRevision.current)setMessage(error instanceof Error?error.message:'Die Sperre konnte nicht aufgelöst werden.');}finally{setLoading(false);}
 }
 if(!available)return connectionError?<section className="panel device-control" aria-label="Smartphone-Kamera"><p role="alert">Die Kamerasteuerung ist nicht erreichbar. Den Aufnahmezustand bitte am Smartphone prüfen.</p></section>:null;
 return <section className="panel device-control" aria-label="Smartphone-Kamera">
  <p className="eyebrow">SMARTPHONE-KAMERA</p><h2>Kamera steuern</h2>
  <p>Die Aufnahme entsteht auf dem Smartphone. Eine Cloud-Speicherung ist erst nach überprüftem Upload bestätigt.</p>
  <label>Kamera <select value={camera?selected:''} disabled={!!pending} onChange={event=>setSelected(event.target.value)}><option value="">Gerät auswählen</option>{cameras.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  {!cameras.length&&<p>Keine Kamera erreichbar.</p>}{connectionError&&<p role="alert">Verbindung unterbrochen. Den Aufnahmezustand bitte am Smartphone prüfen.</p>}
  {claimsError&&<p role="alert">Offene Kameravorgänge konnten nicht geladen werden.</p>}
  {openClaims?.projectId===projectId&&openClaims.claims.length>0&&<div><p><strong>Offene Kameravorgänge für dieses Skript</strong></p><p>Diese Vorgänge bleiben auch sichtbar, wenn das Smartphone nicht erreichbar ist. Prüfe eine mögliche Aufnahme am Gerät; ein Cloud-Upload ist hier noch nicht bestätigt.</p><ul>{openClaims.claims.map(claim=><li key={claim.recordingId}>{claim.deviceName||'Unbekanntes Gerät'} · Aufnahme {claim.recordingId.slice(0,8)} · {claim.lastConfirmedPhase==='ready'?'lokal gespeichert':claim.lastConfirmedPhase==='partial'?'unvollständig':claim.lastConfirmedPhase==='error'?'Fehler gemeldet':'Status ungeklärt'}{claim.recovery&&<CameraRecovery projectId={projectId} recordingId={claim.recordingId} proof={claim.recovery} disabled={recovering!==null&&recovering!==claim.recordingId} onBegin={()=>{if(recoveringRef.current)return false;recoveringRef.current=claim.recordingId;setRecovering(claim.recordingId);return true;}} onEnd={()=>{if(recoveringRef.current===claim.recordingId){recoveringRef.current=null;setRecovering(null);}}} onConfirmed={()=>setMessage('Die Kopie wurde auf dem Server mit passender Prüfsumme bestätigt. Das Original bleibt erhalten.')}/>}</li>)}</ul>{openClaims.hasMore&&<p>Weitere offene Vorgänge werden nicht angezeigt.</p>}</div>}
  {camera&&<p role="status"><strong>{labels[camera.phase]}</strong>{camera.phase==='recording'&&camera.paused===true?' · pausiert':''}{camera.phase==='ready'&&' – der Upload ist damit noch nicht bestätigt.'}{camera.projectId&&camera.projectId!==projectId&&' · Anderes Skript'}</p>}
  {camera&&!controls.supported&&<p>Aufnahmebefehle und Kamerawechsel benötigen eine unterstützte Kameraversion. Eine bereits beobachtete Aufnahme kann weiterhin gestoppt werden.</p>}
  {camera&&controls.supported&&typeof camera.cameraFront==='boolean'&&<p>Ausgewählt: {camera.cameraFront?'Frontkamera':'Rückkamera'}. Kamerawechsel ist nur außerhalb einer Aufnahme möglich.</p>}
  {camera?.lastControl&&['rejected','expired'].includes(camera.lastControl.result)&&<p role="alert">Der letzte Kamerabefehl wurde abgelehnt oder ist am Gerät abgelaufen. Bitte den Zustand am Smartphone prüfen.</p>}
  {camera?.lastControl?.result==='server_expired'&&<p role="alert">Die Serverwartezeit für den letzten Kamerabefehl ist abgelaufen. Das Ergebnis ist ungeklärt; bitte am Smartphone prüfen.</p>}
  {camera?.lastCommand?.result==='accepted'&&camera.lastCommand.receiptCapability!=='remote-record-v4'&&<p role="status">Die Rückmeldung stammt von einer älteren Kameraversion und bestätigt keine Recorder-Zulassung.</p>}
  {camera?.lastCommand?.result==='enqueued'&&<p role="status">Der Start wurde auf dem Smartphone vorgemerkt. Eine laufende Aufnahme ist damit noch nicht bestätigt.</p>}
  {camera&&(camera.uncertain||cameraControlUnsettled(camera))&&<p role="alert">Ein Kamerabefehl ist ausstehend oder ungeklärt. Bitte den Zustand direkt am Smartphone prüfen; neue Befehle bleiben gesperrt. Stopp ist weiterhin möglich.</p>}
  {camera?.lastCommand&&cameraStartWasRefused(camera.lastCommand,camera.lastCommand.id)&&<p role="alert">Die letzte Startanfrage wurde nicht ausgeführt. Bitte den Kamerastatus prüfen.</p>}
  {camera?.recoverableClaim?.projectId===projectId&&<p>Für dieses Skript liegt eine fehlgeschlagene oder unvollständige Aufnahme vor. Eine lokale Datei kann am Smartphone gesichert werden.</p>}
  <div className="device-actions"><button className="primary" disabled={!camera||!controls.supported||camera.phase!=='idle'||camera.pendingStart||camera.uncertain!==false||cameraControlUnsettled(camera)||!!pending||loading||!!inFlightCommand||connectionError} onClick={()=>camera&&void send({id:crypto.randomUUID(),type:'record_start',recordingId:crypto.randomUUID(),projectId,deviceId:camera.id})}>Aufnahme starten</button>
   <button className="secondary-action" disabled={!camera||!camera.recordingId||!['preparing','recording'].includes(camera.phase)||inFlightCommand?.type==='record_stop'} onClick={()=>camera?.recordingId&&void send({id:crypto.randomUUID(),type:'record_stop',recordingId:camera.recordingId,deviceId:camera.id})}>Aufnahme stoppen</button>
   <CameraPanelControls camera={camera} projectId={projectId} busy={!!pending||loading||!!inFlightCommand} offline={connectionError} onControl={type=>{
    if(!camera)return;
    if(type==='camera_switch'){if(typeof camera.cameraFront!=='boolean')return;const id=crypto.randomUUID();void send({id,type,recordingId:id,cameraFrom:camera.cameraFront,deviceId:camera.id});return;}
    if(camera.recordingId)void send({id:crypto.randomUUID(),type,recordingId:camera.recordingId,expectedProjectId:projectId,deviceId:camera.id});
   }}/>
   {pending&&<button className="secondary-action" disabled={loading||!!inFlightCommand||connectionError||(!!camera?.uncertain&&pending.type!=='record_stop')} onClick={()=>void send(pending)}>Anfrage erneut senden</button>}
   {camera?.recoverableClaim?.projectId===projectId&&<button className="secondary-action" disabled={loading||!!inFlightCommand||connectionError||!!pending||!['idle','error','partial'].includes(camera.phase)} onClick={()=>void resolveFailure()}>Aufnahmesperre auflösen</button>}</div>
  {camera&&preview&&<CameraPreview deviceId={camera.id} generation={preview.generation} creationToken={preview.creationToken} available={preview.devices.some(item=>item.deviceId===camera.id&&item.available)}/>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
