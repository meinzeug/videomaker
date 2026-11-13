'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Image as ImageIcon, X } from 'lucide-react';

type ImageMode='render'|'descriptions';
export default function ImageChoiceDialog({title,onClose,onConfirm}:{title:string;onClose:()=>void;onConfirm:(mode:ImageMode)=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [mode,setMode]=useState<ImageMode|null>(null);
 useEffect(()=>{const el=dialog.current;if(!el)return;el.showModal();return()=>{if(el.open)el.close();};},[]);
 return <dialog ref={dialog} className="image-choice-dialog" aria-labelledby="image-choice-title" aria-describedby="image-choice-description" onClose={onClose}>
  <div className="image-choice-header"><div><p className="eyebrow">SKRIPT VORBEREITEN</p><h2 id="image-choice-title">Wie möchtest du deine Bilder?</h2></div><button type="button" className="icon image-choice-close" aria-label="Dialog schließen" onClick={()=>dialog.current?.close()}><X size={20}/></button></div>
  <p id="image-choice-description" className="image-choice-intro">Wähle für „{title}“, was nach der Recherche erstellt werden soll.</p>
  <fieldset className="image-choice-options"><legend>Bildoption wählen</legend>
   <label className={`image-choice-option ${mode==='render'?'selected':''}`}><input autoFocus type="radio" name="image-mode" value="render" checked={mode==='render'} onChange={()=>setMode('render')}/><span className="image-choice-icon"><ImageIcon size={20}/></span><span><b>Bilder erzeugen</b><small>Thumbnail und passende Einblendbilder in Quer- und Hochformat erstellen. Die Bildgenerierung verursacht zusätzliche Kosten.</small></span></label>
   <label className={`image-choice-option ${mode==='descriptions'?'selected':''}`}><input type="radio" name="image-mode" value="descriptions" checked={mode==='descriptions'} onChange={()=>setMode('descriptions')}/><span className="image-choice-icon"><FileText size={20}/></span><span><b>Nur Bildbeschreibungen</b><small>Motivideen und Einsatzstellen als Text erstellen. Bilder können später erzeugt werden.</small></span></label>
  </fieldset>
  <div className="image-choice-actions"><button type="button" className="image-choice-cancel" onClick={()=>dialog.current?.close()}>Abbrechen</button><button type="button" className="primary" disabled={!mode} onClick={()=>{if(mode)onConfirm(mode);}}>Skript erstellen <ArrowRight size={16}/></button></div>
 </dialog>;
}
