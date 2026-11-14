import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {channelForResearch, InvalidGenerationChannel, type GenerationChannel} from './channel-generation.ts';
import {normalizeScriptOptions,type ScriptOptions} from './script-options.ts';

/**
 * A claim is intentionally never expired automatically. Once a provider request
 * may have been sent, only a provider-side idempotency/recovery contract could
 * prove that another call is free of duplicate work/cost.
 */
export const GENERATION_CLAIMS_SCHEMA=`
 CREATE TABLE IF NOT EXISTS generation_claims (
  research_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  image_mode TEXT NOT NULL CHECK(image_mode IN ('render','descriptions')),
  requested_channel TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  channel_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','received','complete','invalid')),
  response_text TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0 CHECK(response_truncated IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS generation_claims_created_idx ON generation_claims(created_at DESC,research_id DESC);`;
export function ensureGenerationClaimsSchema(db:Database.Database){db.exec(GENERATION_CLAIMS_SCHEMA);}
export class GenerationResearchMissing extends Error {}
export class GenerationClaimConflict extends Error {}
export class GenerationClaimStateError extends Error {}
export type GenerationClaim={researchId:string;projectId:string;imageMode:'render'|'descriptions';requestedChannel:string;sourcesJson:string;reportJson:string;channelJson:string;state:'pending'|'received'|'complete'|'invalid';responseText:string|null;responseTruncated:number};
const columns=`research_id AS researchId,project_id AS projectId,image_mode AS imageMode,requested_channel AS requestedChannel,sources_json AS sourcesJson,report_json AS reportJson,channel_json AS channelJson,state,response_text AS responseText,response_truncated AS responseTruncated`;
function requestedChannel(value:unknown):string {
 if(value===null||value===undefined||value==='')return '';
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new InvalidGenerationChannel('Kanalauswahl ist ungültig.');
 return value.toLowerCase();
}
export function readGenerationClaim(db:Database.Database,researchId:string):GenerationClaim|undefined {
 return db.prepare(`SELECT ${columns} FROM generation_claims WHERE research_id=?`).get(researchId) as GenerationClaim|undefined;
}

/** Call inside a SQLite IMMEDIATE transaction, including any session recheck. */
function checkedOptions(report:unknown,input:unknown):ScriptOptions|null {
 const requested=normalizeScriptOptions(input);
 const bound=report&&typeof report==='object'&&Object.prototype.hasOwnProperty.call(report,'generation_options')?normalizeScriptOptions((report as Record<string,unknown>).generation_options):null;
 if(JSON.stringify(requested)!==JSON.stringify(bound))throw new GenerationClaimConflict('Die Skriptvorgaben passen nicht zur gespeicherten Recherche. Bitte mit den ursprünglichen Einstellungen fortfahren.');
 return bound;
}
export function acquireGenerationClaim(db:Database.Database,researchId:string,imageMode:'render'|'descriptions',channelInput:unknown,now:string,optionsInput?:unknown):{claim:GenerationClaim;created:boolean} {
 const requested=requestedChannel(channelInput);
 const prior=readGenerationClaim(db,researchId);
 if(prior){
  if(prior.imageMode!==imageMode||prior.requestedChannel!==requested)throw new GenerationClaimConflict('Für diese Recherche wurde bereits eine Erstellung mit anderen Einstellungen begonnen.');
  checkedOptions(JSON.parse(prior.reportJson),optionsInput);
  return {claim:prior,created:false};
 }
 const research=db.prepare('SELECT sources,report FROM research_reports WHERE id=?').get(researchId) as {sources:string;report:string}|undefined;
 if(!research)throw new GenerationResearchMissing('Recherche nicht gefunden oder abgelaufen. Bitte erneut recherchieren.');
 // Validate/copy before the claim is inserted and before any paid operation.
 JSON.parse(research.sources);
 const report=JSON.parse(research.report);
 checkedOptions(report,optionsInput);
 const channel=channelForResearch(db,report,channelInput);
 const projectId=randomUUID();
 db.prepare(`INSERT INTO generation_claims(research_id,project_id,image_mode,requested_channel,sources_json,report_json,channel_json,state,response_text,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,'pending',NULL,?,?)`).run(researchId,projectId,imageMode,requested,research.sources,research.report,JSON.stringify(channel),now,now);
 return {claim:readGenerationClaim(db,researchId)!,created:true};
}
export function saveGenerationResponse(db:Database.Database,researchId:string,text:string,now:string,truncated=false) {
 const changed=db.prepare("UPDATE generation_claims SET state='received',response_text=?,response_truncated=?,updated_at=? WHERE research_id=? AND state='pending'").run(text,truncated?1:0,now,researchId).changes;
 if(changed!==1)throw new GenerationClaimStateError('Die KI-Antwort konnte nicht eindeutig zugeordnet werden.');
}
export function invalidateGenerationResponse(db:Database.Database,researchId:string,now:string) {
 db.prepare("UPDATE generation_claims SET state='invalid',updated_at=? WHERE research_id=? AND state='received'").run(now,researchId);
}
export function completeGenerationClaim(db:Database.Database,researchId:string,now:string) {
 const changed=db.prepare("UPDATE generation_claims SET state='complete',updated_at=? WHERE research_id=? AND state='received'").run(now,researchId).changes;
 if(changed!==1)throw new GenerationClaimStateError('Der Abschluss konnte nicht eindeutig zugeordnet werden.');
}
export function claimSnapshot(claim:GenerationClaim):{sources:unknown;report:unknown;channel:GenerationChannel|null;options:ScriptOptions|null} {
 const report=JSON.parse(claim.reportJson);
 return {sources:JSON.parse(claim.sourcesJson),report,channel:JSON.parse(claim.channelJson),options:report&&Object.prototype.hasOwnProperty.call(report,'generation_options')?normalizeScriptOptions(report.generation_options):null};
}
