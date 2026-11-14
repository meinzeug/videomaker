/** Detect specific generation-process notes, not general editorial vocabulary. */
export function containsInternalResearchNote(script:string):boolean {
 const text=script.normalize('NFC');
 const references=/(?:\b(?:im|aus\s+dem|laut\s+dem|gemäß\s+dem|in\s+diesem|im\s+mitgelieferten|im\s+vorliegenden|das|dieses)\s+faktenblatt\b)/giu;
 for(const match of text.matchAll(references)){
  // A specifically attributed public document can legitimately be a topic.
  const after=text.slice(match.index+match[0].length,match.index+match[0].length+100);
  if(/^\s+(?:des|der|von)\s+[\p{L}\p{M}]/iu.test(after))continue;
  if(!/^(?:das|dieses)\s/iu.test(match[0])||/\b(?:keine|keinen|keinerlei|fehlt|fehlen|nicht|unklar)\b/iu.test(after))return true;
 }
 for(const match of text.matchAll(/\bstand\s+(?:(?:dieser|der|unserer)\s+)?recherche\b/giu)){
  const after=text.slice(match.index+match[0].length,match.index+match[0].length+100);
  if(!/^\s+(?:des|der|von)\s+[\p{L}\p{M}]/iu.test(after))return true;
 }
 const status='(?:nicht\\s+(?:abrufbar|verfügbar|zugänglich|lesbar|einsehbar)|nicht(?:\\s+vollständig)?\\s+(?:abgerufen|gelesen|geöffnet|eingesehen|geprüft)(?:\\s+werden)?)';
 const sources=/\b(?:pdf|quelle|quellen|quelltext|quelldokument|artikel|webseite)\b/giu;
 for(const match of text.matchAll(sources)){
  const before=text.slice(Math.max(0,match.index-100),match.index),after=text.slice(match.index+match[0].length,match.index+match[0].length+100);
  if(/^\s+(?:des|der|von)\s+[\p{L}\p{M}]/iu.test(after))continue;
  if(new RegExp(`^[^.!?\\r\\n]{0,100}\\b${status}\\b`,'iu').test(after)||new RegExp(`\\b${status}\\b[^.!?\\r\\n]{0,100}$`,'iu').test(before))return true;
 }
 for(const match of text.matchAll(/\b(?:according\s+to|in|on|from)\s+(?:(?:the|this|our)\s+)?(?:(?:provided|current|supplied)\s+)?fact\s*sheet\b/giu)){
  const after=text.slice(match.index+match[0].length,match.index+match[0].length+100);
  if(!/^\s+(?:of|by|from)\s+[\p{L}\p{M}]/iu.test(after))return true;
 }
 const englishSources=/\b(?:pdf|source|document|website)\b/giu,englishStatus=/\b(?:unavailable|not\s+(?:accessible|available|readable)|(?:could|can)\s+not\s+be\s+(?:read|retrieved|accessed|opened))\b/iu;
 for(const match of text.matchAll(englishSources)){
  const after=text.slice(match.index+match[0].length,match.index+match[0].length+100).split(/[.!?\r\n]/u)[0];
  if(/^\s+(?:of|by|from)\s+[\p{L}\p{M}]/iu.test(after))continue;
  if(englishStatus.test(after))return true;
 }
 return false;
}
