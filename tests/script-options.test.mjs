import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {normalizeScriptOptions,InvalidScriptOptions,usesCustomScript} from '../lib/script-options.ts';
import {KONTRAKURS_SCRIPT_SYSTEM,SOURCE_ONLY_SCRIPT_SYSTEM} from '../lib/grok-prompt.ts';
import {acquireGenerationClaim,ensureGenerationClaimsSchema,GenerationClaimConflict,claimSnapshot,saveGenerationResponse} from '../lib/generation-claims.ts';
const options=(values={})=>({mode:'source',scope:'selected',tones:['frech','alltag'],dramaturgy:'Bogen',instructions:'Keine Begrüßung',allowIncompleteSources:false,...values});
const now='2026-11-14T00:00:00.000Z',id='11111111-1111-4111-8111-111111111111';

test('strict options reject wrong types, unknown values, duplicates and oversized instructions',()=>{
 assert.equal(normalizeScriptOptions(undefined),null);
 for(const v of [options({mode:['source']}),options({scope:['selected']}),options({mode:{}}),options({scope:{}}),options({scope:'web'}),options({mode:'else'}),options({tones:['frech','frech']}),options({tones:['invalid']}),options({tones:'frech'}),options({dramaturgy:'a'.repeat(601)}),options({instructions:'a'.repeat(2001)}),options({allowIncompleteSources:'false'}),{...options(),unexpected:true}])assert.throws(()=>normalizeScriptOptions(v),InvalidScriptOptions);
 assert.deepEqual(normalizeScriptOptions(options()).tones,['alltag','frech']);
});

test('explicit source mode preserves neutral rewriting and user options',()=>{
 const o=normalizeScriptOptions(options());
 assert.equal(o.mode,'source');assert.deepEqual(o.tones,['alltag','frech']);assert.equal(o.dramaturgy,'Bogen');assert.equal(o.instructions,'Keine Begrüßung');
 assert.match(SOURCE_ONLY_SCRIPT_SYSTEM,/keine eigene Bewertung/);assert.match(SOURCE_ONLY_SCRIPT_SYSTEM,/Nutzervorgaben/);
 assert.doesNotMatch(SOURCE_ONLY_SCRIPT_SYSTEM,/Du hast eine klare Meinung/);
});

test('default is autonomous and Kontrakurs commentary is optional',()=>{
 assert.equal(usesCustomScript(null),false);
 for(const scope of ['selected','web'])assert.equal(usesCustomScript(normalizeScriptOptions(options({mode:'standard',scope,tones:[],dramaturgy:'',instructions:''}))),false);
 assert.equal(usesCustomScript(normalizeScriptOptions(options({mode:'standard',tones:['frech'],dramaturgy:'',instructions:''}))),true);
 assert.match(KONTRAKURS_SCRIPT_SYSTEM,/Kontrakurs.*Orientierung/);assert.doesNotMatch(KONTRAKURS_SCRIPT_SYSTEM,/Du hast eine klare Meinung/);
});

test('claims bind normalized options and recover the same snapshot after research deletion',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE research_reports(id TEXT PRIMARY KEY,created_at TEXT,sources TEXT,report TEXT); CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT,handle TEXT)');ensureGenerationClaimsSchema(db);
 const o=normalizeScriptOptions(options());db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(id,now,'[]',JSON.stringify({generation_channel:null,generation_options:o,summary:'Ausgewählt'}));
 const acquire=(v)=>db.transaction(()=>acquireGenerationClaim(db,id,'descriptions',null,now,v)).immediate();
 assert.throws(()=>acquire({...options(),instructions:'anders'}),GenerationClaimConflict);
 const first=acquire(options());assert.equal(first.created,true);saveGenerationResponse(db,id,'Antwort',now);db.prepare('DELETE FROM research_reports WHERE id=?').run(id);
 assert.equal(acquire({...options(),tones:['alltag','frech']}).claim.state,'received');
 assert.deepEqual(claimSnapshot(first.claim).options,o);assert.throws(()=>acquire({...options(),scope:'web',mode:'standard'}),GenerationClaimConflict);
 assert.throws(()=>acquire(null),GenerationClaimConflict);
 db.close();
});

test('legacy claims and research remain recoverable with no options',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE research_reports(id TEXT PRIMARY KEY,created_at TEXT,sources TEXT,report TEXT); CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT,handle TEXT)');ensureGenerationClaimsSchema(db);
 db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(id,now,'[]',JSON.stringify({generation_channel:null,summary:'Alt'}));
 const acquire=()=>db.transaction(()=>acquireGenerationClaim(db,id,'descriptions',null,now)).immediate();
 const first=acquire();assert.equal(claimSnapshot(first.claim).options,null);assert.equal(acquire().created,false);db.close();
});
