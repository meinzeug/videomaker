export const SCRIPT_TONES=['alltag','hochdeutsch','frech','arrogant','wuetend','aufbrausend','sachlich','humorvoll','empathisch'] as const;
export type ScriptTone=typeof SCRIPT_TONES[number];
export type ScriptOptions={mode:'standard'|'source'|'commentary';scope:'selected'|'web';tones:ScriptTone[];dramaturgy:string;instructions:string;allowIncompleteSources:boolean};
export class InvalidScriptOptions extends Error {}
export function usesCustomScript(options:ScriptOptions|null):boolean {
 return !!options&&(options.mode!=='standard'||options.tones.length>0||!!options.dramaturgy||!!options.instructions);
}

/** Missing options represent pre-existing clients/jobs and preserve their behavior. */
export function normalizeScriptOptions(value:unknown):ScriptOptions|null {
 if(value===undefined||value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InvalidScriptOptions('Die Skriptvorgaben sind ungültig.');
 const o=value as Record<string,unknown>;
 if(Object.keys(o).some(key=>!['mode','scope','tones','dramaturgy','instructions','allowIncompleteSources'].includes(key)))throw new InvalidScriptOptions('Unbekannte Skriptvorgaben.');
 if(typeof o.mode!=='string'||!['standard','source','commentary'].includes(o.mode)||typeof o.scope!=='string'||!['selected','web'].includes(o.scope))throw new InvalidScriptOptions('Bitte einen gültigen Skriptmodus und Quellenumfang wählen.');
 if(!Array.isArray(o.tones)||o.tones.length>SCRIPT_TONES.length||o.tones.some(t=>typeof t!=='string'||!SCRIPT_TONES.includes(t as ScriptTone))||new Set(o.tones).size!==o.tones.length)throw new InvalidScriptOptions('Die Tonfall-Auswahl ist ungültig.');
 if(typeof o.dramaturgy!=='string'||o.dramaturgy.length>600||typeof o.instructions!=='string'||o.instructions.length>2000||typeof o.allowIncompleteSources!=='boolean')throw new InvalidScriptOptions('Die zusätzlichen Skriptvorgaben sind ungültig oder zu lang.');
 if(o.scope==='web'&&o.mode==='source')throw new InvalidScriptOptions('Zum reinen Umformulieren bitte mindestens eine Quelle auswählen.');
 return {mode:o.mode as ScriptOptions['mode'],scope:o.scope as ScriptOptions['scope'],tones:[...o.tones as ScriptTone[]].sort(),dramaturgy:o.dramaturgy.trim(),instructions:o.instructions.trim(),allowIncompleteSources:o.allowIncompleteSources};
}
