import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {normalizeScriptOptions,InvalidScriptOptions,usesCustomScript} from '../lib/script-options.ts';
import {CUSTOM_SCRIPT_SYSTEM,customScriptPrompt,scriptGenerationPrompt} from '../lib/channel-generation.ts';
import {SYSTEM_PROMPT} from '../lib/openrouter.ts';
import {acquireGenerationClaim,ensureGenerationClaimsSchema,GenerationClaimConflict,claimSnapshot,saveGenerationResponse} from '../lib/generation-claims.ts';
const options=(values={})=>({mode:'source',scope:'selected',tones:['frech','alltag'],dramaturgy:'Bogen',instructions:'Keine Begrüßung',allowIncompleteSources:false,...values});
const now='2026-11-14T00:00:00.000Z',id='11111111-1111-4111-8111-111111111111';

test('strict options reject wrong types, unknown values, duplicates and oversized instructions',()=>{
 assert.equal(normalizeScriptOptions(undefined),null);
 for(const v of [options({mode:['source']}),options({scope:['selected']}),options({mode:{}}),options({scope:{}}),options({scope:'web'}),options({mode:'else'}),options({tones:['frech','frech']}),options({tones:['invalid']}),options({tones:'frech'}),options({dramaturgy:'a'.repeat(601)}),options({instructions:'a'.repeat(2001)}),options({allowIncompleteSources:'false'}),{...options(),unexpected:true}])assert.throws(()=>normalizeScriptOptions(v),InvalidScriptOptions);
 assert.deepEqual(normalizeScriptOptions(options()).tones,['alltag','frech']);
});

test('source mode and tone options produce nonconflicting instructions and channel default duration',()=>{
 const o=normalizeScriptOptions(options());const channel={id,name:'Kanal',platform:'youtube',handle:'@k'};
 const prompt=customScriptPrompt(channel,[{title:'Quelle'}],{summary:'Daten'},o);
 assert.match(prompt,/Keine eigene Bewertung/);assert.match(prompt,/ausschließlich die ausgewählten/);assert.match(prompt,/alltagssprachlich/);assert.match(prompt,/frech/);assert.match(prompt,/10 bis 12 Minuten/);assert.match(prompt,/keine andere Länge/i);assert.match(prompt,/Keine Begrüßung/);
 assert.doesNotMatch(CUSTOM_SCRIPT_SYSTEM,/Empörungs-Hook|politische.*Commentary/i);
});

test('unchanged defaults use established prompts and channel length, independent of source scope',()=>{
 assert.equal(usesCustomScript(null),false);
 for(const scope of ['selected','web'])assert.equal(usesCustomScript(normalizeScriptOptions(options({mode:'standard',scope,tones:[],dramaturgy:'',instructions:''}))),false);
 assert.equal(usesCustomScript(normalizeScriptOptions(options({mode:'standard',tones:['frech'],dramaturgy:'',instructions:''}))),true);
 assert.match(SYSTEM_PROMPT,/politischen Commentary-Kanal/);
 const channel={id,name:'Testkanal',platform:'youtube',handle:'@test'};
 const oldPrompt=scriptGenerationPrompt(channel,[{title:'Ausgewählt'}],{summary:'Beleg'});
 assert.match(oldPrompt,/10 bis 12 Minuten/);assert.match(oldPrompt,/Testkanal/);
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
