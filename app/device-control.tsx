'use client';
import {useEffect,useState} from 'react';

type Device={id:string;name:string;role:string;status:string;last_seen:number;speed:number|null;fontSize:number|null};
type Command='load'|'play'|'pause'|'reset'|'set_speed'|'set_font_size';
type Pending={deviceId:string;field:'speed'|'fontSize';value:number};
export default function DeviceControl({projectId}:{projectId:string}){
 const [devices,setDevices]=useState<Device[]>([]),[selected,setSelected]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [speed,setSpeed]=useState('35'),[fontSize,setFontSize]=useState('44'),[pending,setPending]=useState<Pending|null>(null);
 useEffect(()=>{let mounted=true;const load=async()=>{try{const r=await fetch('/api/devices',{cache:'no-store'});if(!r.ok)throw new Error();const data=await r.json();if(mounted)setDevices(data.devices);}catch{if(mounted)setNotice('Geräteliste konnte nicht geladen werden.');}};void load();const timer=setInterval(load,2000);return()=>{mounted=false;clearInterval(timer);};},[]);
 const prompters=devices.filter(d=>d.role==='prompter'),device=prompters.find(d=>d.id===selected),active=!!device;
 useEffect(()=>{if(pending&&device?.id===pending.deviceId&&typeof device[pending.field]==='number'&&Math.abs(device[pending.field]!-pending.value)<0.001){setNotice('Einstellung vom Smartphone bestätigt.');setPending(null);}},[pending,device]);
 useEffect(()=>{if(!pending)return;const timer=setTimeout(()=>{setPending(null);setNotice('Smartphone hat die Einstellung nicht rechtzeitig bestätigt. Bitte Verbindung prüfen.');},13000);return()=>clearTimeout(timer);},[pending]);
 async function send(type:Command,value?:number){
  const deviceId=selected;
  setBusy(true);setNotice('');try{
   const r=await fetch(`/api/devices/${encodeURIComponent(deviceId)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,projectId:type==='load'?projectId:undefined,value})});
   const data=await r.json();if(!r.ok)throw new Error(data.error||'Befehl fehlgeschlagen.');
   if((type==='set_speed'||type==='set_font_size')&&value!==undefined){setPending({deviceId,field:type==='set_speed'?'speed':'fontSize',value});setNotice('Gesendet. Warte auf den Gerätestatus.');}
   else setNotice('Befehl gesendet. Den Zustand zeigt das Gerät an.');
  }catch(e){setNotice(e instanceof Error?e.message:'Befehl fehlgeschlagen.');}finally{setBusy(false);}
 }
 function select(id:string){setSelected(id);setPending(null);setNotice('');const next=prompters.find(d=>d.id===id);if(next?.speed!=null)setSpeed(String(next.speed));if(next?.fontSize!=null)setFontSize(String(next.fontSize));}
 const available=!!device&&typeof device.speed==='number'&&typeof device.fontSize==='number';
 const speedValue=Number(speed),fontValue=Number(fontSize);
 const validSpeed=speed.trim()!==''&&Number.isFinite(speedValue)&&speedValue>=5&&speedValue<=160;
 const validFont=fontSize.trim()!==''&&Number.isFinite(fontValue)&&fontValue>=20&&fontValue<=100;
 return <section className="panel device-control"><p className="eyebrow">SMARTPHONE-FERNSTEUERUNG</p><h2>Teleprompter verbinden</h2><p>In KontraPrompter am Studio anmelden und die Fernsteuerung aktivieren. Das Gerät muss geöffnet bleiben.</p><label>Anzeige<select value={active?selected:''} onChange={e=>select(e.target.value)}><option value="">Gerät auswählen</option>{prompters.map(item=><option value={item.id} key={item.id}>{item.name} · {item.status}</option>)}</select></label><div className="device-actions"><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('load')}>Skript laden</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('play')}>Start</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('pause')}>Pause</button><button className="secondary-action" disabled={!active||busy} onClick={()=>void send('reset')}>Anfang</button></div>{active&&<div className="device-actions" aria-label="Darstellung auf dem Smartphone"><label htmlFor="device-speed">Tempo (dp/s) <input id="device-speed" type="number" min="5" max="160" step="1" value={speed} onChange={e=>setSpeed(e.target.value)} disabled={!available||busy}/></label><button className="secondary-action" disabled={!available||busy||!validSpeed} onClick={()=>void send('set_speed',speedValue)}>Tempo setzen</button><label htmlFor="device-font">Schriftgröße (sp) <input id="device-font" type="number" min="20" max="100" step="1" value={fontSize} onChange={e=>setFontSize(e.target.value)} disabled={!available||busy}/></label><button className="secondary-action" disabled={!available||busy||!validFont} onClick={()=>void send('set_font_size',fontValue)}>Schrift setzen</button></div>}{available&&<p>Smartphone meldet: {device.speed} dp/s · {device.fontSize} sp</p>}{active&&!available&&<p>Für Tempo und Schriftgröße benötigt das Smartphone eine aktualisierte App.</p>}{!prompters.length&&<p>Kein Anzeigegerät verbunden.</p>}{notice&&<p role="status">{notice}</p>}</section>;
}
