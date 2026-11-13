'use client';
import {useEffect,useState} from 'react';

type Device={id:string;name:string;role:string;status:string;last_seen:number};
export default function DeviceControl({projectId}:{projectId:string}){
 const [devices,setDevices]=useState<Device[]>([]),[selected,setSelected]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let mounted=true;const load=async()=>{try{const r=await fetch('/api/devices',{cache:'no-store'});if(!r.ok)throw new Error();const data=await r.json();if(mounted)setDevices(data.devices);}catch{if(mounted)setNotice('Geräteliste konnte nicht geladen werden.');}};void load();const timer=setInterval(load,2000);return()=>{mounted=false;clearInterval(timer);};},[]);
 async function send(type:'load'|'play'|'pause'|'reset'){
  setBusy(true);setNotice('');try{const r=await fetch(`/api/devices/${encodeURIComponent(selected)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,projectId:type==='load'?projectId:undefined})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Befehl fehlgeschlagen.');setNotice('Befehl gesendet. Den Zustand zeigt das Gerät an.');}catch(e){setNotice(e instanceof Error?e.message:'Befehl fehlgeschlagen.');}finally{setBusy(false);}
 }
 const prompters=devices.filter(d=>d.role==='prompter');const active=prompters.some(d=>d.id===selected);
 return <section className="panel device-control"><p className="eyebrow">SMARTPHONE-FERNSTEUERUNG</p><h2>Teleprompter verbinden</h2><p>In KontraPrompter am Studio anmelden und die Fernsteuerung aktivieren. Das Gerät muss geöffnet bleiben.</p><label>Anzeige<select value={active?selected:''} onChange={e=>setSelected(e.target.value)}><option value="">Gerät auswählen</option>{prompters.map(device=><option value={device.id} key={device.id}>{device.name} · {device.status}</option>)}</select></label><div className="device-actions"><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('load')}>Skript laden</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('play')}>Start</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('pause')}>Pause</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('reset')}>Anfang</button></div>{!prompters.length&&<p>Kein Anzeigegerät verbunden.</p>}{notice&&<p role="status">{notice}</p>}</section>;
}
