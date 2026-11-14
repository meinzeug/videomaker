import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getVideomakerAgencyLinks, saveVideomakerAgencyLinks } from "../server/functions/videomaker-agency.ts";

type Item={kind:"channel"|"project"|"platform";id:string;name:string;platform:string|null};
type Choice=Item&{ticket:string};
type Subject={kind:"document"|"invoice"|"journal";id:string};
const key=(item:Item)=>JSON.stringify([item.kind,item.id]);
const labels={channel:"Kanal",project:"Videomaker-Projekt",platform:"Plattform"} as const;

/** Zusatzinformation für die Agentur; die Buchung selbst wird nicht verändert. */
export function VideomakerAgencyLinks({subject,editable}:{subject:Subject;editable:boolean}) {
  const read=useServerFn(getVideomakerAgencyLinks),save=useServerFn(saveVideomakerAgencyLinks);
  const [existing,setExisting]=useState<Item[]>([]),[choices,setChoices]=useState<Choice[]>([]),[selected,setSelected]=useState<string[]>([]);
  const [version,setVersion]=useState<string|null>(null);
  const [enabled,setEnabled]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    async function load(){
      setLoading(true);setError(null);setMessage(null);
      try{
        const state=await read({data:{kind:subject.kind,id:subject.id}});if(!active)return;
        setEnabled(state.enabled);setExisting(state.items);setSelected(state.items.map(key));setVersion(state.version);
        if(!state.enabled||!editable){setChoices([]);return;}
        const response=await fetch("/api/agency/catalog",{cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("Der Videomaker-Katalog ist momentan nicht verfügbar.");
        const body:unknown=await response.json();
        if(!body||typeof body!=="object"||!("items" in body)||!Array.isArray(body.items))throw new Error("Der Videomaker-Katalog ist ungültig.");
        const list=body.items as Choice[];
        if(list.length>6005||list.some(item=>!item||typeof item.id!=="string"||typeof item.name!=="string"||typeof item.ticket!=="string"||!(["channel","project","platform"] as string[]).includes(item.kind)))throw new Error("Der Videomaker-Katalog ist ungültig.");
        if(active){setChoices(list);if("omitted" in body&&typeof body.omitted==="number"&&body.omitted>0)setMessage(`${body.omitted} Katalogeinträge konnten nicht angezeigt werden.`);}
      }catch(cause){if(active&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:"Die Agenturzuordnung ist momentan nicht verfügbar.");}
      finally{if(active)setLoading(false);}
    }
    void load();return()=>{active=false;controller.abort();};
  },[subject.kind,subject.id,editable,refresh,read]);
  const lookup=new Map(choices.map(choice=>[key(choice),choice]));
  const missing=existing.filter(item=>!lookup.has(key(item))),selectedMissing=missing.some(item=>selected.includes(key(item)));
  const toggle=(id:string)=>setSelected(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);
  async function submit(){
    if(busy||selectedMissing||!version)return;
    setBusy(true);setError(null);setMessage(null);
    try{
      const tickets=selected.map(id=>lookup.get(id)?.ticket);
      if(tickets.some(ticket=>!ticket))throw new Error("Bitte den Katalog erneut laden.");
      const result=await save({data:{subject,version,tickets:tickets.filter((ticket):ticket is string=>!!ticket)}});setVersion(result.version);
      setExisting(selected.map(id=>lookup.get(id)!).filter(Boolean));setMessage("Agenturzuordnung gespeichert.");
    }catch(cause){setError(cause instanceof Error?cause.message:"Die Zuordnung konnte nicht gespeichert werden.");}
    finally{setBusy(false);}
  }
  if(!enabled&&!loading&&!error)return <section className="card" aria-label="Videomaker-Agenturzuordnung"><h2>Agenturzuordnung</h2><p className="muted">Die Verbindung zum Videomaker-Katalog ist noch nicht freigegeben.</p></section>;
  return <section className="card" aria-label="Videomaker-Agenturzuordnung">
    <h2>Agenturzuordnung</h2>
    <p className="muted">Kanäle, Plattformen und Projekte zuordnen. Buchungsbeträge bleiben unverändert.</p>
    {loading&&<p role="status">Zuordnung wird geladen …</p>}
    {error&&<><p role="alert">{error}</p>{editable&&<button className="btn" type="button" onClick={()=>setRefresh(value=>value+1)}>Zuordnung neu laden</button>}</>}{message&&<p role="status">{message}</p>}
    {!loading&&!editable&&<p>{existing.length?existing.map(item=>`${labels[item.kind]}: ${item.name}`).join(" · "):"Keine Agenturzuordnung."}</p>}
    {!loading&&editable&&!error&&<>
      {missing.length>0&&<fieldset><legend>Nicht mehr im Videomaker-Katalog</legend><p className="muted">Vor dem Speichern bitte nicht mehr verfügbare Zuordnungen ausdrücklich abwählen.</p>{missing.map(item=><label key={key(item)} style={{display:"block"}}><input type="checkbox" checked={selected.includes(key(item))} onChange={()=>toggle(key(item))}/> {labels[item.kind]}: {item.name}</label>)}</fieldset>}
      {(["platform","channel","project"] as const).map(kind=>{
        const options=choices.filter(item=>item.kind===kind);if(!options.length)return null;
        return <fieldset key={kind}><legend>{kind==="platform"?"Plattformen":kind==="channel"?"Kanäle":"Projekte"}</legend>{options.map(item=><label key={key(item)} style={{display:"block"}}><input type="checkbox" checked={selected.includes(key(item))} onChange={()=>toggle(key(item))}/> {item.name}{kind==="channel"&&item.platform?` · ${item.platform}`:""}</label>)}</fieldset>;
      })}
      {!choices.length&&<p>Keine Einträge im Videomaker-Katalog.</p>}
      <div className="actions"><button className="btn btn-primary" type="button" disabled={busy||!version||selectedMissing||selected.length>100} onClick={()=>void submit()}>{busy?"Speichere …":"Zuordnung speichern"}</button><button className="btn" type="button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Katalog neu laden</button></div>
      {selected.length>100&&<p role="alert">Höchstens 100 Zuordnungen sind möglich.</p>}
    </>}
  </section>;
}
