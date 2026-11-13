import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSources, validateResearch } from '../lib/research.ts';

const citations=['https://example.org/a','https://example.org/b','https://other.example/c'];
const source=(url)=>({url,title:'Artikel',publisher:'Quelle',date:'2026-11-13'});
const finding=(url)=>({claim:'Eine Aussage',assessment:'belegt',explanation:'Ein belegter Befund',source_urls:[url]});
const report=()=>({summary:'Überblick',sources:citations.map(source),findings:citations.map(finding),hypotheses:[],open_questions:['Was ist noch offen?']});

test('accepts a report supported by tool citations from multiple domains',()=>{
 const result=validateResearch(report(),citations,4);
 assert.equal(result.search_requests,4);
 assert.equal(result.sources.length,3);
 assert.equal(result.findings.length,3);
});

test('discards fabricated source links and unsupported hypotheses',()=>{
 const input=report();
 input.sources.push(source('https://invented.example/fake'));
 input.findings.push(finding('https://invented.example/fake'));
 input.hypotheses.push({question:'Gab es eine Absprache?',indications:'Behauptung',alternative:'Zufall',limitations:'Unbekannt',source_urls:['https://invented.example/fake']});
 const result=validateResearch(input,citations,3);
 assert.equal(result.sources.length,3);
 assert.equal(result.findings.length,3);
 assert.equal(result.hypotheses.length,0);
});

test('rejects insufficient or unverified evidence',()=>{
 assert.throws(()=>validateResearch(report(),[],2),/Quellenreferenzen/);
 assert.throws(()=>validateResearch(report(),citations.slice(0,2),2),/Quellen/);
 const input=report();input.findings=[finding(citations[0])];
 assert.throws(()=>validateResearch(input,citations,2),/Aussagen/);
});

test('rejects unsafe URLs and accepts two concrete HTTPS articles',()=>{
 const valid=[{title:'Eins',url:'https://example.org/story',source:'A'},{title:'Zwei',url:'https://other.example/news',source:'B'}];
 assert.equal(normalizeSources(valid).length,2);
 assert.equal(normalizeSources([{...valid[0],url:'javascript:alert(1)'},valid[1]]),null);
 assert.equal(normalizeSources([{...valid[0],url:'https://example.org/'},valid[1]]),null);
});

test('does not treat a changed query string as a verified source',()=>{
 const input=report();
 input.sources.push(source('https://example.org/a?claim=changed'));
 input.findings.push(finding('https://example.org/a?claim=changed'));
 const result=validateResearch(input,citations,3);
 assert.equal(result.sources.length,3);
 assert.equal(result.findings.length,3);
});
