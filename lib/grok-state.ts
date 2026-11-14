import type Database from 'better-sqlite3';

/** Durable reservations: an in-flight provider call is never silently restarted after a crash. */
export const GROK_STATE_SCHEMA=`
 CREATE TABLE IF NOT EXISTS grok_generation_runs (
  research_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK(phase IN ('facts_pending','facts_ready','facts_invalid','script_pending','script_ready','repair_pending','repair_ready')),
  facts_json TEXT, facts_raw TEXT, script_raw TEXT, repair_raw TEXT,
  primary_model TEXT NOT NULL, fallback_model TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS grok_generation_modes (
  research_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('planned')), plan_json TEXT
 );
 CREATE TABLE IF NOT EXISTS grok_generation_failures (
  research_id TEXT PRIMARY KEY, reason TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS grok_generation_parts (
  research_id TEXT NOT NULL, part INTEGER NOT NULL CHECK(part >= 1),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','invalid')), response TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(research_id,part)
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
export function startGrokRun(db:Database.Database,id:string,now:string,primary:string,fallback:string,multipart=false){
 if(!db.inTransaction)throw new Error('Transaktion erforderlich.');
 db.prepare("INSERT INTO grok_generation_runs(research_id,phase,primary_model,fallback_model,updated_at) VALUES(?,'facts_pending',?,?,?)").run(id,primary,fallback,now);
 if(multipart)db.prepare("INSERT INTO grok_generation_modes(research_id,mode) VALUES(?,'planned')").run(id);
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
export type PartNumber=number;
export type GrokAttemptPhase='facts'|'script'|'repair'|`part${number}`;
export type GrokPart={part:PartNumber;state:'pending'|'ready'|'invalid';response:string|null};
export function isMultipart(db:Database.Database,id:string):boolean {
 return !!db.prepare("SELECT 1 FROM grok_generation_modes WHERE research_id=? AND mode='planned'").get(id);
}
export function readGrokPlan(db:Database.Database,id:string):string[]|null {
 const row=db.prepare('SELECT plan_json AS plan FROM grok_generation_modes WHERE research_id=?').get(id) as {plan:string|null}|undefined;
 if(!row?.plan)return null;
 const value:unknown=JSON.parse(row.plan);
 if(!Array.isArray(value)||!value.length||value.some(x=>typeof x!=='string'||!x.trim()))throw new Error('Gespeicherter Teilplan ist ungültig.');
 return value as string[];
}
/** Facts and their validated plan must be persisted in the same transaction. */
export function saveGrokPlan(db:Database.Database,id:string,plan:string[]) {
 if(!db.inTransaction||!plan.length||plan.some(x=>typeof x!=='string'||!x.trim()))throw new Error('Ungültiger Teilplan.');
 if(db.prepare('UPDATE grok_generation_modes SET plan_json=? WHERE research_id=? AND plan_json IS NULL').run(JSON.stringify(plan),id).changes!==1)throw new Error('Teilplan ist nicht eindeutig.');
}
export function readGrokFailure(db:Database.Database,id:string):string|null {
 const row=db.prepare('SELECT reason FROM grok_generation_failures WHERE research_id=?').get(id) as {reason:string}|undefined;
 return row?.reason??null;
}
export function markGrokFailure(db:Database.Database,id:string,reason:string,now:string) {
 db.prepare('INSERT OR IGNORE INTO grok_generation_failures(research_id,reason,updated_at) VALUES(?,?,?)').run(id,reason,now);
}
export function readGrokParts(db:Database.Database,id:string):GrokPart[] {
 return db.prepare('SELECT part,state,response FROM grok_generation_parts WHERE research_id=? ORDER BY part').all(id) as GrokPart[];
}
export function readGrokPart(db:Database.Database,id:string,part:PartNumber):GrokPart|undefined {
 return db.prepare('SELECT part,state,response FROM grok_generation_parts WHERE research_id=? AND part=?').get(id,part) as GrokPart|undefined;
}
/** Reserve a new part only after the preceding one is durable. Caller owns the transaction. */
export function reserveGrokPart(db:Database.Database,id:string,part:PartNumber,now:string):boolean {
 if(!db.inTransaction)throw new Error('Transaktion erforderlich.');
 const run=readGrokRun(db,id),plan=readGrokPlan(db,id);if(!run||run.phase!=='script_pending'||!plan||!Number.isSafeInteger(part)||part<1||part>plan.length)return false;
 if(part>1&&!db.prepare("SELECT 1 FROM grok_generation_parts WHERE research_id=? AND part=? AND state='ready'").get(id,part-1))return false;
 return db.prepare("INSERT OR IGNORE INTO grok_generation_parts(research_id,part,state,updated_at) VALUES(?,?,'pending',?)").run(id,part,now).changes===1;
}
/** Persist the received response even if its structure is invalid. */
export function saveGrokPart(db:Database.Database,id:string,part:PartNumber,raw:string,valid:boolean,now:string) {
 const n=db.prepare("UPDATE grok_generation_parts SET state=?,response=?,updated_at=? WHERE research_id=? AND part=? AND state='pending'").run(valid?'ready':'invalid',raw,now,id,part).changes;
 if(n!==1)throw new Error('Teilstatus hat sich geändert.');
}
export function beginGrokAttempt(db:Database.Database,id:string,phase:GrokAttemptPhase,model:string,now:string,authorize?:()=>void):number {
 return db.transaction(()=>{
  authorize?.();
  const run=readGrokRun(db,id),partMatch=/^part([1-9][0-9]*)$/.exec(phase);
  if(partMatch){
   const part=Number(partMatch[1]);
   if(!run||run.phase!=='script_pending'||!isMultipart(db,id)||!db.prepare("SELECT 1 FROM grok_generation_parts WHERE research_id=? AND part=? AND state='pending'").get(id,part))throw new Error('KI-Teilphase ist nicht reserviert.');
  }else if(!run||run.phase!==`${phase}_pending`)throw new Error('KI-Phase ist nicht reserviert.');
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
