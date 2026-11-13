'use client';
import { useCallback, useEffect, useState } from 'react';
import { Download, Image as ImageIcon, RefreshCw } from 'lucide-react';

type Asset={id:string;kind:'thumbnail'|'overlay';orientation:'landscape'|'portrait';position:number;label:string;placement:string;status:'pending'|'running'|'ready'|'error';error:string|null};
type State={status:'not_started'|'running'|'complete'|'error';error:string|null;images:Asset[]};

export default function VisualAssets({projectId}:{projectId:string}) {
 const [state,setState]=useState<State|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const [orientation,setOrientation]=useState<'landscape'|'portrait'>('landscape');
 const url=`/api/projects/${encodeURIComponent(projectId)}/images`;
 const load=useCallback(async()=>{
  const response=await fetch(url,{cache:'no-store'});const data=await response.json();
  if(!response.ok)throw new Error(data.error || 'Bildstatus konnte nicht geladen werden.');
  return data as State;
 },[url]);
 useEffect(()=>{
  let active=true;let timer:ReturnType<typeof setTimeout> | undefined;
  async function poll(){try{const result=await load();if(!active)return;setState(result);setError('');if(result.status==='running')timer=setTimeout(poll,2500);}catch(e){if(active)setError(e instanceof Error?e.message:'Bildstatus konnte nicht geladen werden.');}}
  setState(null);void poll();return()=>{active=false;if(timer)clearTimeout(timer);};
 },[load,revision]);
 async function start(){setBusy(true);setError('');try{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Bildgenerierung konnte nicht gestartet werden.');setState(result);setRevision(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'Bildgenerierung konnte nicht gestartet werden.');}finally{setBusy(false);}}
 const thumb=state?.images.find(i=>i.kind==='thumbnail'&&i.orientation===orientation);
 const overlays=state?.images.filter(i=>i.kind==='overlay'&&i.orientation===orientation) || [];
 const completed=state?.images.filter(i=>i.status==='ready').length || 0;
 function renderAsset(asset:Asset) {
  const assetUrl=`${url}/${encodeURIComponent(asset.id)}`;
  return <article className={`visual-asset ${asset.kind==='thumbnail'?'visual-thumbnail':''} ${asset.orientation==='portrait'?'is-portrait':''}`} key={asset.id}>
   {asset.status==='ready'?<a className="visual-preview" href={`${assetUrl}?download=1`} aria-label={`${asset.kind==='thumbnail'?'Thumbnail':asset.label} herunterladen`}><img src={assetUrl} alt={asset.kind==='thumbnail'?`Thumbnail: ${asset.label}`:asset.label} loading="lazy"/></a>:<div className="visual-placeholder"><ImageIcon size={25}/><span>{asset.status==='error'?'Bild fehlgeschlagen':asset.status==='running'?'Bild wird erstellt …':'Wartet auf Erstellung'}</span></div>}
   <div className="visual-info"><div><small>{asset.kind==='thumbnail'?'THUMBNAIL':`EINBLENDUNG ${String(asset.position).padStart(2,'0')}`} · {asset.orientation==='portrait'?'TIKTOK 9:16':'YOUTUBE 16:9'}</small><b>{asset.label}</b>{asset.kind==='overlay'&&<p>Im Skript: „{asset.placement}“</p>}{asset.status==='error'&&asset.error&&<p className="visual-error">{asset.error}</p>}</div>{asset.status==='ready'&&<a className="visual-download" href={`${assetUrl}?download=1`} aria-label={`${asset.kind==='thumbnail'?'Thumbnail':asset.label} herunterladen`}><Download size={17}/><span>Download</span></a>}</div>
  </article>;
 }
 return <section className="visual-section" aria-label="Thumbnail und Einblendbilder">
  <div className="visual-heading"><div><p className="eyebrow">BILDER FÜR DEIN VIDEO</p><h2>Deine Bildauswahl<span>.</span></h2><p>Thumbnail und passende Einblendbilder – jeweils für YouTube und TikTok.</p></div>
   {state && (state.status==='not_started'||state.status==='error')&&<button className="primary" onClick={start} disabled={busy}><RefreshCw size={16}/>{busy?'Wird gestartet …':state.status==='error'?'Fehlende Bilder erneut erstellen':'Bilder erstellen'}</button>}
  </div>
  {error&&<p className="visual-message visual-error" role="alert">{error} <button className="text-button" onClick={()=>setRevision(v=>v+1)}>Erneut laden</button></p>}
  {!state&&!error&&<p className="visual-message" role="status">Bildstatus wird geladen …</p>}
  {state?.status==='not_started'&&<div className="visual-empty"><ImageIcon size={22}/><p>Für dieses Skript wurden noch keine Bilder erstellt.</p></div>}
  {state?.status==='running'&&<div className="progress" role="status"><span className="pulse"/>{state.images.length?`${completed} von ${state.images.length} Bildern fertig. Die übrigen Motive werden erstellt …`:'Das Skript wird analysiert und ein passendes Bildpaket geplant …'}</div>}
  {state?.status==='error'&&<div className="visual-message visual-error" role="alert">{state.error || 'Die Bildgenerierung wurde unterbrochen.'}</div>}
  {!!state?.images.length&&<div className="visual-format" aria-label="Bildformat wählen"><button type="button" aria-pressed={orientation==='landscape'} onClick={()=>setOrientation('landscape')}>YouTube <span>16:9</span></button><button type="button" aria-pressed={orientation==='portrait'} onClick={()=>setOrientation('portrait')}>TikTok <span>9:16</span></button></div>}
  {(thumb||overlays.length>0)&&<div className="visual-layout">{thumb&&renderAsset(thumb)}<div className="visual-overlays">{overlays.map(renderAsset)}</div></div>}
 </section>;
}
