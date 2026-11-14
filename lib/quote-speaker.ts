/** Narrow syntactic attribution checks, not semantic truth verification. */
const name="[\\p{Lu}][\\p{L}\\p{M}'’\\-]*(?:[ \\t]+[\\p{Lu}][\\p{L}\\p{M}'’\\-]*){0,3}";
const verb='(?:sagte|sagt|erklärte|erklärt|schrieb|schreibt|fragte|fragt|betonte|betont|meinte|meint|äußerte|äußert|zitierte|zitiert)';
const beforePattern=new RegExp(`(${name})[ \\t]+(?:${verb}|(?:wird|werde)[ \\t]+zitiert)[ \\t]*[:;,]?[ \\t]*$`,'u');
const afterPattern=new RegExp(`^[ \\t,.:;!?–—-]*(?:${verb}[ \\t]+(${name})|(?:wird|werde)[ \\t]+(${name})[ \\t]+zitiert)(?=$|[^\\p{L}\\p{M}])`,'u');

export function quoteAttributions(before:string,after:string):string[] {
 const left=before.slice(-300).match(beforePattern),right=after.slice(0,300).match(afterPattern);
 return [...new Set([left?.[1],right?.[1],right?.[2]].filter((x):x is string=>!!x))];
}

export function speakerMatches(candidate:string,speaker:string):boolean {
 const expected=speaker.trim().replace(/\s+/gu,' '),actual=candidate.trim().replace(/\s+/gu,' ');
 if(!expected||!actual)return false;
 const surname=expected.split(' ').at(-1);
 return actual===expected||(surname===actual&&!!surname);
}

/** The full supplied context and quote must be exact in the same retrieved source. */
export function sourceConfirmsSpeaker(source:string,quote:string,speaker:string,context:string):boolean {
 if(!quote||!context||!source.includes(context))return false;
 const at=context.indexOf(quote);if(at<0||context.indexOf(quote,at+quote.length)>=0)return false;
 const full=speaker.trim().replace(/\s+/gu,' '),surname=full.split(' ').at(-1);if(!surname)return false;
 if(full.includes(' ')&&!context.includes(full))return false;
 const escaped=surname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const named=new RegExp(`(?:^|[^\\p{L}\\p{M}])([\\p{Lu}][\\p{L}\\p{M}'’\\-]*[ \\t]+${escaped})(?=$|[^\\p{L}\\p{M}])`,'gu');
 const fullNames=[...new Set([...context.matchAll(named)].map(match=>match[1]))];
 if(fullNames.length>1||(full.includes(' ')&&fullNames.some(name=>!full.endsWith(name))))return false;
 // The source may surround a model's bare quote with quotation marks.
 const before=context.slice(0,at).replace(/[„"»«][ \t]*$/u,''),after=context.slice(at+quote.length).replace(/^[“"«»]/u,'');
 const names=quoteAttributions(before,after);
 return names.length>0&&names.every(name=>speakerMatches(name,speaker));
}
