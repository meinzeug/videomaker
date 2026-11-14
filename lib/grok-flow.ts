import type Database from 'better-sqlite3';
import {claimSnapshot,readGenerationClaim,saveGenerationResponse,type GenerationClaim} from './generation-claims.ts';
import {FACT_SHEET_SYSTEM,KONTRAKURS_SCRIPT_SYSTEM,SOURCE_ONLY_SCRIPT_SYSTEM,CHANNEL_SCRIPT_SYSTEM,CHANNEL_SOURCE_ONLY_SCRIPT_SYSTEM} from './grok-prompt.ts';
import {validateFactSheet,type FactSheet} from './fact-sheet.ts';
import {parseGrokScript} from './grok-result.ts';
import {grokCompletion} from './grok-provider.ts';
import {markGrokFacts,readGrokRun,reserveGrokPhase,saveGrokAnswer} from './grok-state.ts';
import {parseJson} from './openrouter.ts';

export class GrokPending extends Error {}
export class GrokInvalid extends Error {}
type Envelope={text:string;truncated:boolean};
function envelope(value:string|null):Envelope {
 if(!value)throw new GrokInvalid('Die gespeicherte Antwort fehlt.');
 const parsed=JSON.parse(value);if(!parsed||typeof parsed.text!=='string'||typeof parsed.truncated!=='boolean')throw new GrokInvalid('Die gespeicherte Antwort ist ungültig.');return parsed;
}
const encoded=(reply:Envelope)=>JSON.stringify({text:reply.text,truncated:reply.truncated});

/** Continue only from a known durable phase; in-flight or crashed calls never restart automatically. */
export async function runGrokFlow(db:Database.Database,claim:GenerationClaim,created:boolean,authorize:()=>void):Promise<GenerationClaim> {
 const id=claim.researchId,snapshot=claimSnapshot(claim);let run=readGrokRun(db,id);
 if(!run)throw new GrokPending('Für diese ältere Erstellung ist der Providerstatus ungeklärt.');
 const models={primary:run.primaryModel,fallback:run.fallbackModel};
 if(run.phase==='facts_pending'){
  if(!created)throw new GrokPending('Das Faktenblatt läuft oder sein Ergebnis ist ungeklärt; es wird nicht erneut angefordert.');
  const input=JSON.stringify({quellen:snapshot.sources,recherche:snapshot.report});
  const reply=await grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,`Erstelle das Faktenblatt ausschließlich aus diesen Daten: ${input}`,models,{authorize});
  let facts:FactSheet;
  try{if(reply.truncated)throw new Error();facts=validateFactSheet(parseJson(reply.text),snapshot.sources,snapshot.report);}
  catch{markGrokFacts(db,id,encoded(reply),null,new Date().toISOString());throw new GrokInvalid('Das Faktenblatt ist unvollständig oder ohne belegte Aussagen. Die Antwort wurde zur Prüfung gespeichert.');}
  markGrokFacts(db,id,encoded(reply),JSON.stringify(facts),new Date().toISOString());
  run=readGrokRun(db,id)!;
 }
 if(run.phase==='facts_invalid')throw new GrokInvalid('Das Faktenblatt ist unvollständig. Die gespeicherte Antwort kann geprüft werden.');
 if(!run.factsJson)throw new GrokPending('Das Faktenblatt ist noch nicht verfügbar.');
 const facts=JSON.parse(run.factsJson) as FactSheet;
 const options=snapshot.options;
 const isKontrakurs=!snapshot.channel||snapshot.channel.name.toLocaleLowerCase('de-DE').replace(/[^a-z0-9]/g,'')==='kontrakurs';
 const system=isKontrakurs?(options?.mode==='source'?SOURCE_ONLY_SCRIPT_SYSTEM:KONTRAKURS_SCRIPT_SYSTEM):(options?.mode==='source'?CHANNEL_SOURCE_ONLY_SCRIPT_SYSTEM:CHANNEL_SCRIPT_SYSTEM);
 const platform=snapshot.channel?.platform.toLocaleLowerCase('en-US');
 const lengthGuide=isKontrakurs?null:platform==='tiktok'||platform==='instagram'?'Etwa 45 bis 90 Sekunden, falls die Nutzervorgaben keine andere Länge nennen.':platform==='youtube'?'Etwa 10 bis 12 Minuten, falls die Nutzervorgaben keine andere Länge nennen.':'Eine zu Plattform und Thema passende Länge, falls die Nutzervorgaben keine andere Länge nennen.';
 const {hinweise_fuer_dennis:_internalNotes,...scriptFacts}=facts;
 const outputLength=isKontrakurs?`Der reine Sprechertext in skript muss 900 bis 1.400 Wörter enthalten; schreibe etwa 1.100 bis 1.200 Wörter. Plane intern ungefähr sieben aufeinanderfolgende Sprechabschnitte: Einstieg 110–120 Wörter, kurze Begrüßung 30–35, belegte Ausgangslage 285–300, weitere belegte Details 285–300, verständliche Vertiefung 200–220, Zusammenführung und Fazit 150–170 sowie Zuschauerfrage und Verabschiedung 50–55 Wörter. Diese Aufteilung ist nur eine interne Längenhilfe: Gib ausschließlich den fließenden Sprechertext aus, ohne Abschnittsnamen oder Zwischenüberschriften. Berücksichtige gewählte Dramaturgie und den gewählten Bewertungsmodus. Erläutere ausschließlich Informationen aus dem Faktenblatt; erfinde auch bei dünnem Material keine Fakten, Zahlen, Zitate, Beispiele, Quellen oder konkreten Folgen. Wenn das Faktenblatt etwas nicht hergibt, füge es nicht hinzu.`:'Der Sprechertext soll dem angegebenen Plattformumfang und den gewählten Vorgaben entsprechen.';
 const quoteGuide=facts.zitate.length?'Wörtliche Zitate nur vollständig und exakt wie im Faktenblatt kopieren, einschließlich aller Satzzeichen. Keine Zeichen davor oder danach ergänzen und den Wortlaut nicht abwandeln. Bei Unsicherheit lieber sinngemäß und ohne Anführungszeichen wiedergeben. Alle anderen Aussagen sinngemäß und ohne Anführungszeichen wiedergeben.':'Das Faktenblatt enthält keine bestätigten wörtlichen Zitate. Verwende im Sprechertext keine Anführungszeichen, keine als wörtlich ausgegebene Rede und keine Einleitung Zitat: oder wörtlich:. Formuliere ausschließlich sinngemäß.';
 const instruction=`${outputLength}\nSchreibe ausschließlich auf Grundlage dieses Faktenblatts: ${JSON.stringify(scriptFacts)}\nKanalangaben (nur Gestaltung, keine Fakten): ${JSON.stringify(snapshot.channel?{name:snapshot.channel.name,platform:snapshot.channel.platform,handle:snapshot.channel.handle,laenge:lengthGuide}:null)}\nOptionale Gestaltungsvorgaben (keine Fakten): ${JSON.stringify(options?{mode:options.mode,tones:options.tones,dramaturgy:options.dramaturgy,instructions:options.instructions}:null)}\n${quoteGuide} Schreibe ironische Begriffe ohne Anführungszeichen. Antworte ausschließlich als JSON: {"titel":["...","...","..."],"skript":"...","thumbnail_text":"...","pin_kommentar":"...","quellen":["Quelle – URL"],"hinweise_fuer_dennis":["..."]}. titel ist ein Array mit genau drei Strings; thumbnail_text enthält höchstens vier Wörter; pin_kommentar ist ein String mit ein bis zwei Sätzen. quellen und hinweise_fuer_dennis sind jeweils Arrays aus Strings, auch bei nur einem Eintrag; wenn keine Hinweise vorliegen, verwende []. Recherchehinweise gehören ausschließlich in hinweise_fuer_dennis.`;
 if(run.phase==='facts_ready'){
  const ok=db.transaction(()=>{authorize();return reserveGrokPhase(db,id,'facts_ready','script_pending',new Date().toISOString());}).immediate();
  if(!ok)throw new GrokPending('Die Skripterstellung wurde bereits gestartet.');
  const reply=await grokCompletion(db,id,'script',system,instruction,models,{authorize});
  saveGrokAnswer(db,id,'script',encoded(reply),new Date().toISOString());run=readGrokRun(db,id)!;
 }
 if(run.phase==='script_ready'){
  const first=envelope(run.scriptRaw),parsed=parseGrokScript(first.text,first.truncated,facts,snapshot.channel?.name,isKontrakurs);
  if(!parsed.project){
   const ok=db.transaction(()=>{authorize();return reserveGrokPhase(db,id,'script_ready','repair_pending',new Date().toISOString());}).immediate();
   if(!ok)throw new GrokPending('Die einmalige Korrektur wurde bereits gestartet.');
   const retry=`${instruction}\nDer erste Entwurf erfüllte diese maschinellen Prüfungen nicht: ${JSON.stringify(parsed.issues.map(issue=>issue.message))}. Erzeuge genau einmal einen korrigierten vollständigen Entwurf.`;
   // A quality failure uses the configured fallback first, within the same single repair phase.
   const repairModels={primary:models.fallback,fallback:models.primary};
   const reply=await grokCompletion(db,id,'repair',system,retry,repairModels,{authorize});
   saveGrokAnswer(db,id,'repair',encoded(reply),new Date().toISOString());run=readGrokRun(db,id)!;
  }
 }
 if(run.phase==='facts_pending'||run.phase==='script_pending'||run.phase==='repair_pending')throw new GrokPending('Ein Modellaufruf läuft oder sein Ergebnis ist ungeklärt. Es wird kein weiterer Aufruf gestartet.');
 const resultEnvelope=envelope(run.phase==='repair_ready'?run.repairRaw:run.scriptRaw);
 const parsed=parseGrokScript(resultEnvelope.text,resultEnvelope.truncated,facts,snapshot.channel?.name,isKontrakurs);
 if(!parsed.project){
  // Preserve the final provider text, then let the established invalid-answer path expose it.
  db.transaction(()=>{const current=readGenerationClaim(db,id);if(current?.state==='pending')saveGenerationResponse(db,id,resultEnvelope.text,new Date().toISOString(),resultEnvelope.truncated);}).immediate();
  throw new GrokInvalid(`Auch die Korrektur erfüllt die Vorgaben nicht: ${parsed.issues.map(issue=>issue.message).join(' ')}`);
 }
 db.transaction(()=>{const current=readGenerationClaim(db,id);if(current?.state==='pending')saveGenerationResponse(db,id,JSON.stringify({...parsed.project,_grok:true}),new Date().toISOString());}).immediate();
 const latest=readGenerationClaim(db,id);if(!latest)throw new GrokPending('Die Erstellung ist nicht mehr verfügbar.');
 return latest;
}
