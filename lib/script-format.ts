/** Preserve the producer's copy, adding the channel framing only when it is missing. */
export function channelGreetingMayMismatch(script:string,channelName:string):boolean {
 const opening=script.slice(0,1000);
 const matched=opening.match(/\bwillkommen\s+bei\s+([^.!?\n]{1,100})/iu);
 if(!matched)return false;
 const normalize=(s:string)=>s.trim().replace(/\s+/g,' ').toLocaleLowerCase('de-DE');
 return normalize(matched[1])!==normalize(channelName);
}
export function ensureChannelFraming(script:string,channelName?:string,platform?:string):string {
 let result=script.trim();
 const opening=result.slice(0,1000);
 if(!/\b(?:hallo|willkommen|servus|moin|grüß(?:e|t| dich| euch)|guten (?:morgen|tag|abend))\b/iu.test(opening)){
  const endings=[...result.matchAll(/[.!?…]["'“”»)]*(?:\s+|$)/gu)];
  let insert=endings[1]?.index!==undefined?endings[1].index+endings[1][0].length:endings[0]?.index!==undefined?endings[0].index+endings[0][0].length:-1;
  if(insert<0){const newline=result.indexOf('\n');const space=result.indexOf(' ',200);insert=newline>0?newline:space>0?space:result.length;}
  const greeting=channelName?`Willkommen bei ${channelName.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()}.`:'Willkommen bei Kontrakurs.';
  result=`${result.slice(0,insert).trimEnd()}\n\n${greeting}\n\n${result.slice(insert).trimStart()}`.trim();
 }
 const ending=result.slice(-1200);
 const likes=/\b(?:like|liken|likest|gefällt mir|daumen (?:hoch|nach oben))\b/iu.test(ending);
 const subscribe=/\b(?:abonn\w*|abo|subscribe\w*)\b/iu.test(ending)||!!channelName&&/\bfolg(?:e|t|en|st)\b/iu.test(ending);
 const comment=/\b(?:komment\w*|meinung (?:dazu )?(?:in|unten)|schreib\w*[^.!?\n]{0,60}(?:unten|darunter))\b/iu.test(ending);
 const goodbye=/(?:\b(?:tschüss|ciao|wiedersehen|wiederhören|verabschiede|bis bald)\b|bis zum nächsten mal|bis zur nächsten|mach(?:t)?[’']?s gut|sehen uns (?:beim|im|in der|zur|zum))/iu.test(ending);
 if(!likes||!subscribe||!comment||!goodbye)result+=channelName&&platform?.toLowerCase()!=='youtube'?"\n\nWenn dir das Video gefallen hat, lass ein Like da, folge diesem Kanal und schreib deine Meinung in die Kommentare. Mach's gut und bis zum nächsten Mal!":"\n\nWenn dir das Video gefallen hat, lass ein Like da, abonniere den Kanal und schreib deine Meinung in die Kommentare. Mach's gut und bis zum nächsten Mal!";
 return result;
}
