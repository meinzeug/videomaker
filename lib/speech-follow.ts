export type ScriptWord={text:string;start:number;end:number;normalized:string};
const pattern=/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
export function normalizeWord(value:string){return value.toLocaleLowerCase('de-DE').replace(/ß/g,'ss').normalize('NFKD').replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');}
export function scriptWords(text:string):ScriptWord[]{return [...text.matchAll(pattern)].map(match=>({text:match[0],start:match.index!,end:match.index!+match[0].length,normalized:normalizeWord(match[0])}));}
function similar(a:string,b:string){
 if(a===b)return true;
 if(Math.min(a.length,b.length)<5||Math.abs(a.length-b.length)>1)return false;
 let i=0,j=0,changes=0;
 while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++changes>1)return false;if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}}
 return changes+(i<a.length||j<b.length?1:0)<=1;
}
/** Matches a recognition fragment against a short forward-only section of the script. */
export function matchSpokenWords(words:ScriptWord[],transcript:string,anchor:number):number|null {
 const spoken=scriptWords(transcript).map(word=>word.normalized).slice(0,1000);
 if(spoken.length<2||!words.length)return null;
 const start=Math.max(0,Math.min(words.length,Math.floor(anchor)));
 const limit=Math.min(words.length,start+Math.min(1200,Math.max(65,spoken.length*2+16)));
 let next=start,matched=0,last=-1;
 for(const word of spoken){
  const end=Math.min(limit,next+(matched?6:16));let found=-1;
  for(let i=next;i<end;i++)if(similar(word,words[i].normalized)){found=i;break;}
  if(found>=0){matched++;last=found;next=found+1;}
 }
 return matched>=2&&matched/spoken.length>=0.34?last+1:null;
}
