/** Optional editorial material is displayed outside the text used by the teleprompter. */
export default function ScriptExtras({pinComment,notes,originalScript,sourceEvidence}:{pinComment?:unknown;notes?:unknown;originalScript?:unknown;sourceEvidence?:unknown}) {
 const comment=typeof pinComment==='string'&&pinComment.trim()?pinComment:null;
 const hints=Array.isArray(notes)?notes.filter((value):value is string=>typeof value==='string'&&value.trim().length>0):[];
 const original=typeof originalScript==='string'&&originalScript.trim()?originalScript:null;
 const evidence=Array.isArray(sourceEvidence)?sourceEvidence.flatMap((item:unknown)=>{
  if(!item||typeof item!=='object')return [];
  const value=item as {aussage?:unknown;belege?:unknown;ungeprueft?:unknown};
  if(typeof value.aussage!=='string'||!Array.isArray(value.belege))return [];
  const sources=value.belege.flatMap((entry:unknown)=>{
   if(!entry||typeof entry!=='object')return [];
   const source=entry as {text?:unknown;quelle?:unknown;ungeprueft?:unknown};
   if(typeof source.text!=='string'||typeof source.quelle!=='string')return [];
   try{const url=new URL(source.quelle);return url.protocol==='https:'?[{text:source.text,url:url.href,unverified:source.ungeprueft===true}]:[];}catch{return [];}
  });
  return sources.length?[{statement:value.aussage,sources,unverified:value.ungeprueft===true}]:[];
 }):[];
 if(!comment&&!hints.length&&!original&&!evidence.length)return null;
 return <>
  {comment&&<section className="panel" aria-label="Angepinnter Kommentar"><p className="eyebrow">ZUM VIDEO</p><h2>Angepinnter Kommentar</h2><p className="preline">{comment}</p></section>}
  {hints.length>0&&<section className="panel" aria-label="Hinweise für Dennis"><p className="eyebrow">INTERN</p><h2>Hinweise für Dennis</h2><p className="muted">Diese Hinweise gehören nicht zum Sprechertext.</p><ul>{hints.map((hint,index)=><li className="preline" key={index}>{hint}</li>)}</ul></section>}
  {evidence.length>0&&<section className="panel" aria-label="Quellenbelege"><details><summary>Quellenbelege ansehen</summary><p className="muted">Die Textstellen wurden abgeglichen. Ob sie die jeweilige Aussage im Zusammenhang tragen, ist damit nicht automatisch bewiesen.</p>{evidence.map((item,index)=><div key={index}><p><strong>{item.statement}</strong>{item.unverified?' · ungeprüfte Kurzbeschreibung':''}</p>{item.sources.map((source,sourceIndex)=><blockquote key={sourceIndex}><p className="preline">{source.text}</p><a href={source.url} target="_blank" rel="noopener noreferrer">{source.unverified?'Kurzbeschreibung · ungeprüft':'Quelle öffnen'}</a></blockquote>)}</div>)}</details></section>}
  {original&&<section className="panel" aria-label="Ursprünglicher KI-Entwurf"><details><summary>Ursprünglichen KI-Entwurf anzeigen</summary><p className="muted">Dieser Entwurf enthält möglicherweise ungeprüfte Zitate und wurde nicht als Sprechertext übernommen.</p><p className="preline">{original}</p></details></section>}
 </>;
}
