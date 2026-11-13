import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scriptWords,matchSpokenWords,normalizeWord} from '../lib/speech-follow.ts';

test('matches the spoken script despite punctuation, capitalization and a small transcription error',()=>{
 const words=scriptWords('Hallo zusammen, willkommen bei Kontrakurs. Heute schauen wir auf die hohen Strompreise.');
 assert.equal(matchSpokenWords(words,'hallo zusammen willkommen bei kontrakurs',0),5);
 assert.equal(matchSpokenWords(words,'heute schauen wir auf die hohen stromprese',5),12);
 assert.equal(normalizeWord('GRÜẞE'),'grusse');
});
test('ignores unrelated sounds and single words instead of jumping',()=>{
 const words=scriptWords('Ein langer Einstieg mit mehreren ganz konkreten Worten und einer Aussage.');
 assert.equal(matchSpokenWords(words,'husten räuspern',0),null);
 assert.equal(matchSpokenWords(words,'ein',0),null);
});
test('matches near the current position without jumping to a distant repeated passage',()=>{
 const words=scriptWords('Wir sehen uns heute. Ein anderer Satz. Wir sehen uns morgen.');
 assert.equal(matchSpokenWords(words,'wir sehen uns',0),3);
 assert.equal(matchSpokenWords(words,'wir sehen uns',7),10);
});
test('tolerates a few spoken filler words and omitted script words',()=>{
 const words=scriptWords('Das ist heute eine wirklich wichtige Entscheidung für alle Bürger.');
 assert.equal(matchSpokenWords(words,'das ist äh heute eine wichtige entscheidung',0),7);
});
test('keeps following a long interim recognition result',()=>{
 const text=Array.from({length:100},(_,i)=>`wort${i}`).join(' ');
 assert.equal(matchSpokenWords(scriptWords(text),text,0),100);
});
