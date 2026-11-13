import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseManualPackage,parseManualScript} from '../lib/manual.ts';
import {normalizeSources} from '../lib/research.ts';

test('a news package can be saved without sources, while research can accept a topic without sources',()=>{
 assert.deepEqual(parseManualPackage({title:'Thema',angle:'Eigener Blickwinkel',sources:[]}),{title:'Thema',angle:'Eigener Blickwinkel',sources:[]});
 assert.deepEqual(normalizeSources([],0),[]);
 assert.equal(normalizeSources([]),null);
});
test('manual links must be unique, safe HTTPS article URLs',()=>{
 const valid={url:'https://example.org/artikel',title:'',source:'',date:'',description:''};
 const result=parseManualPackage({title:'Thema',sources:[valid]});
 assert.equal(result.sources[0].title,'example.org');
 const dated=parseManualPackage({title:'Thema',sources:[{...valid,date:'2026-11-13T13:45:22.000Z'}]});
 assert.equal(dated.sources[0].date,'2026-11-13T13:45:22.000Z');
 assert.throws(()=>parseManualPackage({title:'Thema',sources:[valid,valid]}),/einmal/);
 for(const url of ['javascript:alert(1)','http://example.org/artikel','https://example.org/','https://user@example.org/artikel'])assert.throws(()=>parseManualPackage({title:'Thema',sources:[{...valid,url}]}));
});
test('manual scripts preserve user text, alternative titles and source information',()=>{
 const result=parseManualScript({title:'Mein Titel',script:'\nErster Absatz.\n\nZweiter Absatz.\n',thumbnail:'Titelbild',broll:['Bild eins'],titles:['Alternative'],sources:[{url:'https://example.org/news',title:'Bericht',source:'Medium',date:'2026-11-13',description:'Kurz'}]});
 assert.equal(result.script,'\nErster Absatz.\n\nZweiter Absatz.\n');
 assert.deepEqual(result.titles,['Mein Titel','Alternative']);
 assert.equal(result.sources[0].description,'Kurz');
 assert.throws(()=>parseManualScript({title:'',script:'Text',broll:[]}),/Titel/);
});
