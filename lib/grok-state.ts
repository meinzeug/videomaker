import type Database from 'better-sqlite3';

/** Durable reservations: an in-flight provider call is never silently restarted after a crash. */
export const GROK_STATE_SCHEMA=`
 CREATE TABLE IF NOT EXISTS grok_generation_runs (
  research_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK(phase IN ('facts_pending','facts_ready','facts_invalid','script_pending','script_ready','repair_pending','repair_ready')),
  facts_json TEXT, facts_raw TEXT, script_raw TEXT, repair_raw TEXT,
  primary_model TEXT NOT NULL, fallback_model TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS grok_generation_attempts (
  research_id TEXT NOT NULL, phase TEXT NOT NULL, ordinal INTEGER NOT NULL, requested_model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('inflight','received','failed','unknown')),
  status_code INTEGER, actual_model TEXT, generation_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
  reasoning_tokens INTEGER, total_tokens INTEGER, cost_usd REAL, started_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY(research_id,phase,ordinal)
 );`;
export type GrokPhase='facts_pending'|'facts_ready'|'facts_invalid'|'script_pending'|'script_ready'|'repair_pending'|'repair_ready';
export type GrokRun={researchId:string;phase:GrokPhase;factsJson:string|null;factsRaw:string|null;scriptRaw:string|null;repairRaw:string|null;primaryModel:string;fallbackModel:string};
export type Usage={model:string|null;id:string|null;promptTokens:number|null;completionTokens:number|null;reasoningTokens:number|null;totalTokens:number|null;costUsd:number|null};
export function ensureGrokStateSchema(db:Database.Database){db.exec(GROK_STATE_SCHEMA);}
export function readGrokRun(db:Database.Database,id:string):GrokRun|undefined {
 return db.prepare('SELECT research_id AS researchId,phase,facts_json AS factsJson,facts_raw AS factsRaw,script_raw AS scriptRaw,repair_raw AS repairRaw,primary_model AS primaryModel,fallback_model AS fallbackModel FROM grok_generation_runs WHERE research_id=?').get(id) as GrokRun|undefined;
}
/** Must be called in the same transaction as acquiring the generation claim. */
export function startGrokRun(db:Database.Database,id:string,now:string,primary:string,fallback:string){
 if(!db.inTransaction)throw new Error('Transaktion erforderlich.');
 db.prepare("INSERT INTO grok_generation_runs(research_id,phase,primary_model,fallback_model,updated_at) VALUES(?,'facts_pending',?,?,?)").run(id,primary,fallback,now);
}
export function markGrokFacts(db:Database.Database,id:string,raw:string,facts:string|null,now:string){
 const phase=facts===null?'facts_invalid':'facts_ready';
 const n=db.prepare("UPDATE grok_generation_runs SET phase=?,facts_raw=?,facts_json=?,updated_at=? WHERE research_id=? AND phase='facts_pending'").run(phase,raw,facts,now,id).changes;
 if(n!==1)throw new Error('Faktenblattstatus hat sich geändert.');
}
/** Reserve the next paid phase under the caller's session-checked IMMEDIATE transaction. */
export function reserveGrokPhase(db:Database.Database,id:string,from:'facts_ready'|'script_ready',to:'script_pending'|'repair_pending',now:string):boolean {
 if(!db.inTransaction)throw new Error('Transaktion erforderlich.');
 if(!((from==='facts_ready'&&to==='script_pending')||(from==='script_ready'&&to==='repair_pending')))throw new Error('Ungültiger Phasenwechsel.');
 return db.prepare('UPDATE grok_generation_runs SET phase=?,updated_at=? WHERE research_id=? AND phase=?').run(to,now,id,from).changes===1;
}
export function saveGrokAnswer(db:Database.Database,id:string,phase:'script'|'repair',raw:string,now:string){
 const column=phase==='script'?'script_raw':'repair_raw',from=phase==='script'?'script_pending':'repair_pending',to=phase==='script'?'script_ready':'repair_ready';
 const n=db.prepare(`UPDATE grok_generation_runs SET ${column}=?,phase=?,updated_at=? WHERE research_id=? AND phase=?`).run(raw,to,now,id,from).changes;
 if(n!==1)throw new Error('Skriptstatus hat sich geändert.');
}
export function beginGrokAttempt(db:Database.Database,id:string,phase:'facts'|'script'|'repair',model:string,now:string,authorize?:()=>void):number {
 return db.transaction(()=>{
  authorize?.();
  const run=readGrokRun(db,id);if(!run||run.phase!==`${phase}_pending`)throw new Error('KI-Phase ist nicht reserviert.');
  const ordinal=(db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM grok_generation_attempts WHERE research_id=? AND phase=?').get(id,phase) as {n:number}).n;
  db.prepare("INSERT INTO grok_generation_attempts(research_id,phase,ordinal,requested_model,state,started_at) VALUES(?,?,?,?,'inflight',?)").run(id,phase,ordinal,model,now);
  return ordinal;
 }).immediate();
}
export function finishGrokAttempt(db:Database.Database,id:string,phase:string,ordinal:number,state:'received'|'failed'|'unknown',status:number|null,usage:Usage|null,now:string){
 const u=usage;
 const n=db.prepare(`UPDATE grok_generation_attempts SET state=?,status_code=?,actual_model=?,generation_id=?,prompt_tokens=?,completion_tokens=?,reasoning_tokens=?,total_tokens=?,cost_usd=?,finished_at=? WHERE research_id=? AND phase=? AND ordinal=? AND state='inflight'`)
  .run(state,status,u?.model??null,u?.id??null,u?.promptTokens??null,u?.completionTokens??null,u?.reasoningTokens??null,u?.totalTokens??null,u?.costUsd??null,now,id,phase,ordinal).changes;
 if(n!==1)throw new Error('KI-Versuch ist nicht eindeutig gespeichert.');
}
