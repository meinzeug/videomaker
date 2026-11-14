import assert from 'node:assert/strict';
import {test} from 'node:test';
import {countScriptWords,KONTRAKURS_OUTRO,KONTRAKURS_SUBSCRIBE_SENTENCE,validateKontrakursScript} from '../lib/script-quality.ts';

function scriptWithWords(count){
 const required=`${KONTRAKURS_SUBSCRIBE_SENTENCE}\n${KONTRAKURS_OUTRO}`;
 const padding=count-countScriptWords(required);
 assert.ok(padding>=0);
 return `${'Klartext '.repeat(padding)}\n${required}`;
}
const codes=result=>result.issues.map(issue=>issue.code);

test('counting supports German words, combining marks, numbers and punctuation',()=>{
 assert.equal(countScriptWords('Straße gru\u0308n gibt\'s gibt’s E-Mail 1.234,50 12,5 – 🙂'),7);
 assert.equal(countScriptWords('  ... 🙂 # ‽  '),0);
 assert.throws(()=>countScriptWords(null),TypeError);
});

test('word-limit boundaries include both required sentences',()=>{
 for(const count of [900,1400]){
  const result=validateKontrakursScript(scriptWithWords(count));
  assert.equal(result.wordCount,count);
  assert.equal(result.valid,true,JSON.stringify(result.issues));
 }
 for(const count of [899,1401]){
  const result=validateKontrakursScript(scriptWithWords(count));
  assert.equal(result.wordCount,count);
  assert.ok(codes(result).includes('word_count'));
 }
});

test('requires the exact subscription sentence and exact final wording',()=>{
 const base=scriptWithWords(900);
 assert.equal(validateKontrakursScript(`${base}\n \t`).valid,true);
 const alteredCta=base.replace('Daumen nach oben.','Daumen hoch.');
 assert.ok(codes(validateKontrakursScript(alteredCta)).includes('missing_subscribe'));
 const alteredOutro=base.replace('Ciao, bis bald!','Tschüss!');
 assert.ok(codes(validateKontrakursScript(alteredOutro)).includes('missing_outro'));
 assert.ok(codes(validateKontrakursScript(`${base}\nNoch ein Satz.`)).includes('missing_outro'));
});

test('finds all requested forbidden patterns regardless of casing or whitespace',()=>{
 const base=scriptWithWords(900);
 const patterns=['rEcHeRcHe','pdf','Stand\n  dieser','LA\u0308SST SICH NICHT','Kein Beweis für eine Lüge','BEIDES KANN','Überschrift','[pAuSe]','##'];
 for(const pattern of patterns){
  const result=validateKontrakursScript(`${pattern}\n${base}`);
  assert.ok(codes(result).includes('forbidden_pattern'),pattern);
 }
});

test('recognizes numbered and Markdown headings even with CRLF and indentation',()=>{
 const base=scriptWithWords(900);
 for(const heading of ['1. Einleitung','  2) Hintergrund','3 – Fazit','4: Überblick','\t# 5. Kapitel','1.1 Einordnung','2.3.1 Details']){
  const result=validateKontrakursScript(`${heading}\r\n${base}`);
  assert.ok(codes(result).includes('numbered_heading'),heading);
 }
 assert.ok(codes(validateKontrakursScript(`# Thema\n${base}`)).includes('markdown_heading'));
 for(const date of ['1. Januar beginnt die Änderung.','31. März tritt das Gesetz in Kraft.','2. MAERZ folgt der Termin.'])
  assert.ok(!codes(validateKontrakursScript(`${date}\n${base}`)).includes('numbered_heading'),date);
});

test('returns machine-readable simultaneous issues and refuses non-string input',()=>{
 const result=validateKontrakursScript('## 1. Recherche\nZu kurz.');
 assert.equal(result.valid,false);
 for(const code of ['missing_outro','missing_subscribe','forbidden_pattern','numbered_heading','word_count'])assert.ok(codes(result).includes(code),code);
 assert.throws(()=>validateKontrakursScript(undefined),TypeError);
});
