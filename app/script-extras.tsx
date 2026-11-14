/** Optional editorial material is displayed outside the text used by the teleprompter. */
export default function ScriptExtras({pinComment,notes}:{pinComment?:unknown;notes?:unknown}) {
 const comment=typeof pinComment==='string'&&pinComment.trim()?pinComment:null;
 const hints=Array.isArray(notes)?notes.filter((value):value is string=>typeof value==='string'&&value.trim().length>0):[];
 if(!comment&&!hints.length)return null;
 return <>
  {comment&&<section className="panel" aria-label="Angepinnter Kommentar"><p className="eyebrow">ZUM VIDEO</p><h2>Angepinnter Kommentar</h2><p className="preline">{comment}</p></section>}
  {hints.length>0&&<section className="panel" aria-label="Hinweise für Dennis"><p className="eyebrow">INTERN</p><h2>Hinweise für Dennis</h2><p className="muted">Diese Hinweise gehören nicht zum Sprechertext.</p><ul>{hints.map((hint,index)=><li className="preline" key={index}>{hint}</li>)}</ul></section>}
 </>;
}
