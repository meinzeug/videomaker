'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Image as ImageIcon, X } from 'lucide-react';
import type {Channel} from '@/lib/channels';
import type {ScriptOptions,ScriptTone} from '@/lib/script-options';
import type {Source} from './studio-types';

type ImageMode='render'|'descriptions';
export type ScriptDialogDraft={options:ScriptOptions;selectedIndexes:number[];imageMode:ImageMode;channelId:string|null};
const tones:ReadonlyArray<[ScriptTone,string]>=[['alltag','Alltagssprache'],['hochdeutsch','Hochdeutsch'],['frech','Frech'],['arrogant','Arrogant'],['wuetend','Wütend'],['aufbrausend','Aufbrausend'],['sachlich','Sachlich'],['humorvoll','Humorvoll'],['empathisch','Empathisch']];
export default function ImageChoiceDialog({title,sources,channels,initial,error,onClose,onConfirm}:{title:string;sources:Source[];channels:Channel[];initial?:ScriptDialogDraft|null;error?:string;onClose:()=>void;onConfirm:(mode:ImageMode,channelId:string|null,options:ScriptOptions,selected:Source[],selectedIndexes:number[])=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [mode,setMode]=useState<ImageMode|null>(initial?.imageMode??null),[channelId,setChannelId]=useState(initial?.channelId??'');
 const [selected,setSelected]=useState(()=>new Set(sources.flatMap((_,index)=>!initial||initial.selectedIndexes.includes(index)?[index]:[])));
 const [scriptMode,setScriptMode]=useState<ScriptOptions['mode']>(initial?.options.mode??'standard');
 const [chosenTones,setChosenTones]=useState<ScriptTone[]>(initial?.options.tones??[]),[dramaturgy,setDramaturgy]=useState(initial?.options.dramaturgy??''),[instructions,setInstructions]=useState(initial?.options.instructions??''),[allowIncompleteSources,setAllowIncompleteSources]=useState(initial?.options.allowIncompleteSources??false);
 const [scope,setScope]=useState<ScriptOptions['scope']>(initial?.options.scope??(sources.length?'selected':'web'));
 useEffect(()=>{const el=dialog.current;if(!el)return;el.showModal();return()=>{if(el.open)el.close();};},[]);
 function toggleSource(index:number){setSelected(previous=>{const next=new Set(previous);if(next.has(index))next.delete(index);else next.add(index);return next;});}
 function toggleTone(tone:ScriptTone){setChosenTones(previous=>previous.includes(tone)?previous.filter(value=>value!==tone):[...previous,tone]);}
 return <dialog ref={dialog} className="image-choice-dialog" aria-labelledby="image-choice-title" aria-describedby="image-choice-description" onClose={onClose}>
  <div className="image-choice-header"><div><p className="eyebrow">SKRIPT VORBEREITEN</p><h2 id="image-choice-title">Gestalte dein Skript.</h2></div><button type="button" className="icon image-choice-close" aria-label="Dialog schließen" onClick={()=>dialog.current?.close()}><X size={20}/></button></div>
  <p id="image-choice-description" className="image-choice-intro">Lege für „{title}“ Quellen, Ton und Bildoption fest. Alle weiteren Vorgaben sind optional.</p>
  {error&&<p className="alert" role="alert">{error}</p>}
  {channels.length>0&&<label className="image-choice-channel">Kanal für dieses Skript<select value={channelId} onChange={event=>setChannelId(event.target.value)}><option value="">Kein Kanal</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{channel.name} · {channel.platform}{channel.handle?` · ${channel.handle}`:''}</option>)}</select><small>Kanalname und Plattform werden bei der Erstellung berücksichtigt.</small></label>}
  <fieldset className="script-choice-section"><legend>Quellen</legend>
   {sources.length?<><p>Wähle mindestens eine Ausgangsquelle.</p>{sources.map((source,index)=><label key={`${source.url}-${index}`} className="script-source"><input type="checkbox" checked={selected.has(index)} onChange={()=>toggleSource(index)}/><span><b>{source.title}</b><small>{source.source||source.url}</small></span></label>)}{selected.size===0&&<p role="alert">Bitte mindestens eine Quelle auswählen.</p>}<label className="script-check"><input type="radio" name="source-scope" checked={scope==='selected'} onChange={()=>setScope('selected')}/><span>Nur ausgewählte Artikel verwenden; keine weitere Websuche</span></label><label className="script-check"><input type="radio" name="source-scope" checked={scope==='web'} onChange={()=>{setScope('web');if(scriptMode==='source')setScriptMode('standard');}}/><span>Zusätzlich frei im Web recherchieren. Dabei können weitere und auch abgewählte Quellen gefunden werden.</span></label>{scope==='selected'&&<label className="script-check"><input type="checkbox" checked={allowIncompleteSources} onChange={event=>setAllowIncompleteSources(event.target.checked)}/><span>Wenn eine Quelle nicht abrufbar ist, ihre gespeicherte Kurzbeschreibung verwenden.</span></label>}<small>Automatisch ausgelesene Artikel können unvollständig sein. Aussagen und Quellen bitte selbst prüfen.</small></>:<p>Dieses Paket hat keine Quellen. Für das Thema wird eine freie Webrecherche gestartet; dabei können neue Quellen hinzukommen.</p>}
  </fieldset>
  <fieldset className="script-choice-section"><legend>Inhalt und Einordnung</legend>
   <label className="script-check"><input type="radio" name="script-mode" checked={scriptMode==='standard'} onChange={()=>setScriptMode('standard')}/><span>Ohne weitere inhaltliche Vorgabe</span></label>
   <label className="script-check"><input type="radio" name="script-mode" disabled={!sources.length||scope!=='selected'} checked={scriptMode==='source'} onChange={()=>setScriptMode('source')}/><span>Quellen in eigenen Worten aufbereiten, ohne eigene Bewertung</span></label>
   <label className="script-check"><input type="radio" name="script-mode" checked={scriptMode==='commentary'} onChange={()=>setScriptMode('commentary')}/><span>Mit eigener Einordnung und Einschätzung</span></label>
  </fieldset>
  <fieldset className="script-choice-section"><legend>Tonfall und Ausdruck</legend><p>Mehrfachauswahl möglich. Du kannst Stile miteinander mischen.</p><div className="script-tone-list">{tones.map(([value,label])=><label className="script-tone" key={value}><input type="checkbox" checked={chosenTones.includes(value)} onChange={()=>toggleTone(value)}/><span>{label}</span></label>)}</div></fieldset>
  <label className="script-text-field">Dramaturgie <span>optional</span><textarea maxLength={600} rows={3} value={dramaturgy} onChange={event=>setDramaturgy(event.target.value)} placeholder="z. B. mit einer überraschenden Frage beginnen und die Spannung langsam steigern"/><small>{dramaturgy.length}/600</small></label>
  <label className="script-text-field">Weitere Vorgaben <span>optional</span><textarea maxLength={2000} rows={3} value={instructions} onChange={event=>setInstructions(event.target.value)} placeholder="z. B. Anrede, Sprecherstil, Länge oder weitere Wünsche"/><small>{instructions.length}/2000</small></label>
  <fieldset className="image-choice-options"><legend>Bildoption wählen</legend>
   <label className={`image-choice-option ${mode==='render'?'selected':''}`}><input type="radio" name="image-mode" value="render" checked={mode==='render'} onChange={()=>setMode('render')}/><span className="image-choice-icon"><ImageIcon size={20}/></span><span><b>Bilder erzeugen</b><small>Thumbnail und passende Einblendbilder in Quer- und Hochformat erstellen. Die Bildgenerierung verursacht zusätzliche Kosten.</small></span></label>
   <label className={`image-choice-option ${mode==='descriptions'?'selected':''}`}><input type="radio" name="image-mode" value="descriptions" checked={mode==='descriptions'} onChange={()=>setMode('descriptions')}/><span className="image-choice-icon"><FileText size={20}/></span><span><b>Nur Bildbeschreibungen</b><small>Motivideen und Einsatzstellen als Text erstellen. Bilder können später erzeugt werden.</small></span></label>
  </fieldset>
  <div className="image-choice-actions"><button type="button" className="image-choice-cancel" onClick={()=>dialog.current?.close()}>Abbrechen</button><button type="button" className="primary" disabled={!mode||(sources.length>0&&selected.size===0)} onClick={()=>{if(mode)onConfirm(mode,channelId||null,{mode:scriptMode,scope,tones:chosenTones,dramaturgy,instructions,allowIncompleteSources},sources.filter((_,index)=>selected.has(index)),[...selected]);}}>Skript erstellen <ArrowRight size={16}/></button></div>
 </dialog>;
}
