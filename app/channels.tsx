'use client';
import {useEffect,useState} from 'react';
import {ArrowLeft,MessageSquare,Pencil,Plus,Trash2} from 'lucide-react';
import type {Channel} from '@/lib/channels';
import {ChatModal} from './chat-panel';

const labels:Record<string,string>={youtube:'YouTube',tiktok:'TikTok',instagram:'Instagram',facebook:'Facebook',other:'Andere'};
const LIMIT=10000;
const day=(s:string)=>new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'short',year:'numeric',timeZone:'Europe/Berlin'}).format(new Date(s));
async function json(url:string,options?:RequestInit){const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'Anfrage fehlgeschlagen.');return data;}
const jsonPost=(method:string,body:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const platformName=(channel:Channel)=>labels[channel.platform]||channel.platform;
const filled=(text?:string)=>!!text&&text.trim().length>0;

type View={mode:'list'}|{mode:'detail';id:string}|{mode:'edit';id:string|null};

export function Channels({channels,onChanged}:{channels:Channel[];onChanged:()=>Promise<void>}) {
 const [view,setView]=useState<View>({mode:'list'}),[error,setError]=useState('');
 const current=view.mode==='list'?null:channels.find(c=>c.id===(view as {id:string|null}).id)||null;
 useEffect(()=>{if(view.mode!=='list'&&(view as {id:string|null}).id&&!current)setView({mode:'list'});},[view,current]);
 async function remove(channel:Channel){
  if(!confirm(`Kanal „${channel.name}“ wirklich löschen?\n\nZuordnungen zu Skripten, gespeicherte Vorgaben und Chats dieses Kanals werden entfernt. Die Skripte selbst bleiben erhalten.`))return;
  setError('');
  try{await json(`/api/channels/${channel.id}`,{method:'DELETE'});await onChanged();setView({mode:'list'});}catch(e){setError(e instanceof Error?e.message:'Kanal konnte nicht gelöscht werden.');}
 }
 if(view.mode==='edit')return <ChannelForm channel={current} onFieldSaved={onChanged} onCancel={()=>setView(current?{mode:'detail',id:current.id}:{mode:'list'})} onSaved={async id=>{await onChanged();setView({mode:'detail',id});}}/>;
 if(view.mode==='detail'&&current)return <ChannelDetail channel={current} error={error} onBack={()=>setView({mode:'list'})} onEdit={()=>setView({mode:'edit',id:current.id})} onDelete={()=>void remove(current)}/>;
 return <>
  <div className="section-heading large"><div><p className="eyebrow">DEINE KANÄLE</p><h1>Ein Studio. Viele Kanäle<span>.</span></h1><p>Verwalte deine Kanäle samt dauerhaften Vorgaben für Dramaturgie und Skripte.</p></div><button className="primary" onClick={()=>setView({mode:'edit',id:null})}><Plus size={16}/> Kanal hinzufügen</button></div>
  {error&&<p role="alert" className="error">{error}</p>}
  <section className="panel channel-table-wrap" aria-label="Kanäle">
   {channels.length?<table className="channel-table"><thead><tr><th scope="col">Kanal</th><th scope="col">Plattform</th><th scope="col">Kennung</th><th scope="col">Skriptvorgaben</th><th scope="col">Angelegt</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead><tbody>
    {channels.map(channel=><tr key={channel.id} onClick={()=>setView({mode:'detail',id:channel.id})}>
     <td data-label="Kanal"><button type="button" className="channel-link" onClick={e=>{e.stopPropagation();setView({mode:'detail',id:channel.id});}}>{channel.name}</button></td>
     <td data-label="Plattform">{platformName(channel)}</td>
     <td data-label="Kennung">{channel.handle||<span className="muted">—</span>}</td>
     <td data-label="Skriptvorgaben"><span className={`channel-tag ${filled(channel.dramaturgy)?'on':''}`}>Dramaturgie</span> <span className={`channel-tag ${filled(channel.instructions)?'on':''}`}>Vorgaben</span></td>
     <td data-label="Angelegt">{day(channel.created_at)}</td>
     <td className="channel-actions"><button type="button" className="icon" aria-label={`${channel.name} bearbeiten`} title="Bearbeiten" onClick={e=>{e.stopPropagation();setView({mode:'edit',id:channel.id});}}><Pencil size={17}/></button><button type="button" className="icon danger" aria-label={`${channel.name} löschen`} title="Löschen" onClick={e=>{e.stopPropagation();void remove(channel);}}><Trash2 size={17}/></button></td>
    </tr>)}
   </tbody></table>:<div className="empty-news"><h3>Noch keine Kanäle</h3><p>Lege deinen ersten Kanal an, um Skripte zuzuordnen und Vorgaben zu speichern.</p><button className="text-button" onClick={()=>setView({mode:'edit',id:null})}>Kanal hinzufügen</button></div>}
   <p className="muted">Die Kanalverwaltung speichert Zuordnungen und Vorgaben. Eine Verbindung zu Plattformkonten oder Veröffentlichung ist noch nicht eingerichtet.</p>
  </section>
 </>;
}

function ChannelDetail({channel,error,onBack,onEdit,onDelete}:{channel:Channel;error:string;onBack:()=>void;onEdit:()=>void;onDelete:()=>void}) {
 const block=(title:string,text?:string)=><section className="panel"><p className="eyebrow">{title}</p>{filled(text)?<p className="preline">{text}</p>:<p className="muted">Nicht festgelegt.</p>}<small className="muted">{(text||'').length.toLocaleString('de-DE')} / {LIMIT.toLocaleString('de-DE')} Zeichen</small></section>;
 return <>
  <button className="back" onClick={onBack}><ArrowLeft size={16}/> Alle Kanäle</button>
  <div className="detail-heading"><div><p className="eyebrow">KANAL / {platformName(channel).toUpperCase()}</p><h1>{channel.name}<span>.</span></h1></div><div className="heading-actions"><button className="secondary-action" onClick={onEdit}><Pencil size={16}/> Bearbeiten</button><button className="secondary-action danger" onClick={onDelete}><Trash2 size={16}/> Löschen</button></div></div>
  {error&&<p role="alert" className="error">{error}</p>}
  <section className="panel"><p className="eyebrow">EINSTELLUNGEN</p><dl className="channel-facts"><div><dt>Name</dt><dd>{channel.name}</dd></div><div><dt>Plattform</dt><dd>{platformName(channel)}</dd></div><div><dt>Kanalkennung</dt><dd>{channel.handle||'—'}</dd></div><div><dt>Angelegt am</dt><dd>{day(channel.created_at)}</dd></div></dl></section>
  <div className="detail-grid channel-guidelines">{block('SKRIPTE / DRAMATURGIE',channel.dramaturgy)}{block('SKRIPTE / SONSTIGE VORGABEN',channel.instructions)}</div>
  <p className="muted">Diese Vorgaben können beim Erstellen eines Skripts aus einem News-Paket automatisch angewendet werden.</p>
 </>;
}

type ChatField='dramaturgy'|'instructions';
function ChannelForm({channel,onCancel,onSaved,onFieldSaved}:{channel:Channel|null;onCancel:()=>void;onSaved:(id:string)=>Promise<void>;onFieldSaved:()=>Promise<void>}) {
 const known=channel&&labels[channel.platform]?channel.platform:channel?'other':'youtube';
 const [name,setName]=useState(channel?.name??''),[platform,setPlatform]=useState(known),[customPlatform,setCustomPlatform]=useState(channel&&known==='other'?channel.platform:''),[handle,setHandle]=useState(channel?.handle??'');
 const [dramaturgy,setDramaturgy]=useState(channel?.dramaturgy??''),[instructions,setInstructions]=useState(channel?.instructions??'');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[chat,setChat]=useState<ChatField|null>(null);
 async function save(e:React.FormEvent){
  e.preventDefault();setBusy(true);setError('');
  try{
   const body={name,platform:platform==='other'?customPlatform:platform,handle,dramaturgy,instructions};
   const saved=channel?await json(`/api/channels/${channel.id}`,jsonPost('PUT',body)):await json('/api/channels',jsonPost('POST',body));
   await onSaved(saved.id);
  }catch(e){setError(e instanceof Error?e.message:'Kanal konnte nicht gespeichert werden.');setBusy(false);}
 }
 const area=(field:ChatField,label:string,hint:string,value:string,set:(v:string)=>void)=><div className="guideline-field"><div className="guideline-head"><label htmlFor={`g-${field}`}>{label}</label><button type="button" className="icon" disabled={!channel} aria-label={`Mit der KI über „${label}“ chatten`} title={channel?'Mit der KI darüber chatten':'Kanal erst speichern, dann chatten'} onClick={()=>setChat(field)}><MessageSquare size={18}/></button></div><textarea id={`g-${field}`} rows={9} maxLength={LIMIT} value={value} onChange={e=>set(e.target.value)} placeholder={hint}/><small className={value.length>=LIMIT?'limit':''}>{value.length.toLocaleString('de-DE')} / {LIMIT.toLocaleString('de-DE')}</small></div>;
 return <>
  <button className="back" onClick={onCancel}><ArrowLeft size={16}/> Abbrechen</button>
  <div className="section-heading large"><div><p className="eyebrow">{channel?'KANAL BEARBEITEN':'NEUER KANAL'}</p><h1>{channel?channel.name:'Kanal hinzufügen'}<span>.</span></h1></div></div>
  <form className="channel-form panel" onSubmit={save}>
   <h2>Einstellungen</h2>
   <label>Name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="z. B. Kontrakurs"/></label>
   <label>Plattform<select value={platform} onChange={e=>setPlatform(e.target.value)}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   {platform==='other'&&<label>Plattformname<input required maxLength={80} value={customPlatform} onChange={e=>setCustomPlatform(e.target.value)} placeholder="z. B. Twitch"/></label>}
   <label>Kanalkennung (optional)<input maxLength={100} value={handle} onChange={e=>setHandle(e.target.value)} placeholder="z. B. @kontrakurs"/></label>
   <h2>Skripte dieses Kanals</h2>
   <p className="muted">Diese Vorgaben werden bei der Skripterstellung für diesen Kanal automatisch angewendet (abschaltbar im Erstellungsdialog). Jedes Feld fasst bis zu 10.000 Zeichen.</p>
   {area('dramaturgy','Dramaturgie','z. B. Aufbau, Spannungsbogen, Hook, Schluss …',dramaturgy,setDramaturgy)}
   {area('instructions','Sonstige Vorgaben','z. B. Anrede, Sprecherstil, Länge, Dos und Don’ts …',instructions,setInstructions)}
   {error&&<p role="alert" className="error">{error}</p>}
   <div className="form-actions"><button className="primary" disabled={busy}>{busy?'Speichert …':channel?'Änderungen speichern':'Kanal anlegen'}</button><button type="button" className="secondary-action" onClick={onCancel} disabled={busy}>Abbrechen</button></div>
  </form>
  {chat&&channel&&<ChatModal kind={chat==='dramaturgy'?'channel_dramaturgy':'channel_instructions'} refId={channel.id} draft={chat==='dramaturgy'?dramaturgy:instructions} title={chat==='dramaturgy'?'Dramaturgie besprechen':'Sonstige Vorgaben besprechen'} subtitle={`Kanal: ${channel.name} · Der Chat bezieht sich auf den aktuellen Text im Feld. Auf deine Bitte kann die KI einen Text direkt im Feld speichern.`} intro={chat==='dramaturgy'?'Besprich mit der KI die Dramaturgie deiner Skripte: Aufbau, Hook, Spannungsbogen, Schluss.':'Besprich mit der KI Anrede, Stil, Länge und weitere Vorgaben für deine Skripte.'} suggestions={chat==='dramaturgy'?['Bewerte meine aktuelle Dramaturgie','Welche Dramaturgie funktioniert für diese Plattform aktuell gut?']:['Sind meine Vorgaben widerspruchsfrei?','Was sollte ich noch festlegen?']} onSaved={saved=>{if(typeof saved.text!=='string')return;if(saved.kind==='channel_dramaturgy')setDramaturgy(saved.text);else setInstructions(saved.text);void onFieldSaved();}} onClose={()=>setChat(null)}/>}
 </>;
}
export function ProjectChannels({projectId,channels}:{projectId:string;channels:Channel[]}) {
 const [selected,setSelected]=useState<string[]>([]),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[loadFailed,setLoadFailed]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{const controller=new AbortController();setLoading(true);setLoadFailed(false);setSelected([]);setMessage('');json(`/api/projects/${encodeURIComponent(projectId)}/channels`,{signal:controller.signal}).then(data=>setSelected(data.channelIds)).catch(e=>{if(e.name!=='AbortError'){setLoadFailed(true);setMessage('Kanalzuordnung konnte nicht geladen werden. Bitte Seite erneut öffnen.');}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[projectId]);
 async function save(){setSaving(true);setMessage('');try{const data=await json(`/api/projects/${encodeURIComponent(projectId)}/channels`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelIds:selected})});setSelected(data.channelIds);setMessage('Zuordnung gespeichert.');}catch(e){setMessage(e instanceof Error?e.message:'Speichern fehlgeschlagen.');}finally{setSaving(false);}}
 return <section className="panel channel-assignment"><p className="eyebrow">KANÄLE & PLATTFORMEN</p><h2>Dieses Skript einsetzen</h2>{channels.length?<><p>Wähle alle passenden Kanäle.</p>{channels.map(channel=><label key={channel.id}><input type="checkbox" disabled={loading||saving||loadFailed} checked={selected.includes(channel.id)} onChange={e=>setSelected(items=>e.target.checked?[...items,channel.id]:items.filter(id=>id!==channel.id))}/><span>{channel.name} · {labels[channel.platform]||channel.platform}{channel.handle?` · ${channel.handle}`:''}</span></label>)}<button className="secondary-action" disabled={loading||saving||loadFailed} onClick={()=>void save()}>{saving?'Speichert …':'Zuordnung speichern'}</button></>:<p>Noch keine Kanäle angelegt. Öffne „Kanäle“, um zu beginnen.</p>}{message&&<p role="status">{message}</p>}</section>;
}
