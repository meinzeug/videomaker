/** Deterministic checks for the user's Kontrakurs editorial format. */
export const KONTRAKURS_SUBSCRIBE_SENTENCE = 'Wenn ihr weiter Klartext wollt, lasst ein Abo da und gebt dem Video einen Daumen nach oben.';
export const KONTRAKURS_OUTRO = 'Ich bin gespannt, wie ihr das seht, denn dieses Video ist jetzt mit Absicht zu Ende. Ciao, bis bald!';
export const KONTRAKURS_MIN_WORDS = 900;
export const KONTRAKURS_MAX_WORDS = 1400;

export type ScriptQualityIssue = {
 code:'missing_outro'|'missing_subscribe'|'forbidden_pattern'|'numbered_heading'|'markdown_heading'|'word_count';
 message:string;
 /** Present only for a matching forbidden pattern. */
 pattern?:string;
};
export type ScriptQualityResult = {valid:boolean;wordCount:number;issues:ScriptQualityIssue[]};

/**
 * Count Unicode letter/number runs. Internal apostrophes and dashes join words;
 * decimal/thousands separators join adjacent digits. Punctuation and emojis on
 * their own are not words. No language-dependent tokenizer is required.
 */
export function countScriptWords(script:string):number {
 if(typeof script!=='string')throw new TypeError('Skripttext muss eine Zeichenkette sein.');
 const token=/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:(?:['’ʼ\u2010-\u2015-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)|(?:[.,](?=\p{N})\p{N}+))*/gu;
 let count=0;
 for(const _match of script.matchAll(token))count++;
 return count;
}

const forbidden=['Recherche','PDF','Stand dieser','lässt sich nicht','kein Beweis für eine Lüge','Beides kann','Überschrift','[Pause]','##'] as const;
const normalized=(text:string)=>text.normalize('NFC').toLocaleLowerCase('de-DE').replace(/\s+/gu,' ');
/** The phrase "Stand dieser" must not match inside another Unicode word.
 * All other user-specified patterns retain their original substring semantics. */
function containsForbidden(text:string,pattern:string):boolean {
 if(pattern!==normalized('Stand dieser'))return text.includes(pattern);
 return /(?<![\p{L}\p{M}\p{N}_])stand dieser(?![\p{L}\p{M}\p{N}_])/u.test(text);
}
function hasNumberedHeading(script:string):boolean {
 const numbering=/^[^\S\r\n]*(?:#{1,6}[^\S\r\n]*)?(?:\d{1,3}(?:\.\d{1,3})*[.)]|\d{1,3}\.\d{1,3}(?:\.\d{1,3})*|\d{1,3}[^\S\r\n]*[-–—:])[^\S\r\n]+\S/mu;
 const date=/^[^\S\r\n]*\d{1,2}\.[^\S\r\n]+(?:januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)(?=$|[^\p{L}\p{M}])/iu;
 return script.split(/\r\n|\r|\n/u).some(line=>numbering.test(line)&&!date.test(line));
}

/**
 * These are mechanical checks, not factual verification. In particular, a
 * plain unnumbered heading cannot be recognized reliably without semantics.
 */
export function validateKontrakursScript(script:string):ScriptQualityResult {
 if(typeof script!=='string')throw new TypeError('Skripttext muss eine Zeichenkette sein.');
 const issues:ScriptQualityIssue[]=[];
 const wordCount=countScriptWords(script);
 if(!script.trimEnd().endsWith(KONTRAKURS_OUTRO))issues.push({code:'missing_outro',message:'Der vorgeschriebene Schlusssatz fehlt oder ist nicht der letzte Satz.'});
 if(!script.includes(KONTRAKURS_SUBSCRIBE_SENTENCE))issues.push({code:'missing_subscribe',message:'Der vorgeschriebene Abo-Satz fehlt oder weicht vom genauen Wortlaut ab.'});
 const comparable=normalized(script);
 for(const pattern of forbidden)if(containsForbidden(comparable,normalized(pattern)))issues.push({code:'forbidden_pattern',pattern,message:`Verbotenes Muster gefunden: ${pattern}`});
 if(hasNumberedHeading(script))issues.push({code:'numbered_heading',message:'Eine nummerierte Zwischenüberschrift oder Liste wurde gefunden.'});
 if(/^[^\S\r\n]*#[^\S\r\n]+\S/mu.test(script))issues.push({code:'markdown_heading',message:'Eine Markdown-Überschrift wurde gefunden.'});
 if(wordCount<KONTRAKURS_MIN_WORDS||wordCount>KONTRAKURS_MAX_WORDS)issues.push({code:'word_count',message:`Das Skript hat ${wordCount} Wörter; zulässig sind 900 bis 1.400.`});
 return {valid:issues.length===0,wordCount,issues};
}
