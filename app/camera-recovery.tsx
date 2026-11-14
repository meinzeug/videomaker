'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {uploadCameraRecovery} from '@/lib/camera-recovery-client';

type Proof={sizeBytes:number;sha256:string};

/** Explicitly upload an existing copy; never touches or deletes the camera's file. */
export default function CameraRecovery({projectId,recordingId,proof,disabled,onBegin,onEnd,onConfirmed}:{projectId:string;recordingId:string;proof:Proof;disabled:boolean;onBegin:()=>boolean;onEnd:()=>void;onConfirmed:()=>void}){
 const [file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const input=useId(),current=useRef<AbortController|null>(null),mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(current.current){current.current.abort();current.current=null;onEnd();}};},[projectId,recordingId]);
 async function start(){
  if(!file||disabled||current.current||!onBegin())return;
  const controller=new AbortController();current.current=controller;setBusy(true);setStatus('Die Datei wird geprüft und übertragen …');
  try{
   await uploadCameraRecovery(file,projectId,recordingId,proof,controller.signal);
   if(!mounted.current||current.current!==controller)return;
   setFile(null);setStatus('Der Upload wurde mit passender Prüfsumme vom Server bestätigt.');onConfirmed();
  }catch(error){
   if(mounted.current&&current.current===controller)setStatus(controller.signal.aborted?'Abbruch angefordert. Der Server könnte die Aufnahme bereits übernommen haben; bitte den Uploadstatus erneut prüfen.':error instanceof Error&&/^(Die Dateigröße|Die Datei stimmt|Der Gerätenachweis)/.test(error.message)?error.message:'Die Wiederherstellung wurde nicht bestätigt. Der Server könnte die Aufnahme bereits übernommen haben; bitte den Uploadstatus prüfen und gegebenenfalls erneut versuchen.');
  }finally{if(current.current===controller){current.current=null;onEnd();}if(mounted.current)setBusy(false);}
 }
 return <div><p>Eine Kopie dieser vollständig gemeldeten Aufnahme kann von diesem Gerät hochgeladen werden. Dateigröße und Prüfsumme müssen zum Smartphone passen; das Original bleibt erhalten.</p>
  <label htmlFor={input}>MP4-Kopie auswählen</label> <input id={input} type="file" accept="video/mp4,.mp4" disabled={busy||disabled} onChange={event=>{setFile(event.target.files?.[0]||null);setStatus('');}}/>
  <button type="button" className="secondary-action" disabled={!file||busy||disabled} onClick={()=>void start()}>Kopie prüfen und hochladen</button>
  {busy&&<button type="button" className="secondary-action" onClick={()=>{current.current?.abort();setStatus('Abbruch angefordert …');}}>Abbrechen</button>}
  {status&&<p role="status">{status}</p>}
 </div>;
}
