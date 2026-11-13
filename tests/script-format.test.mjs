import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureChannelFraming} from '../lib/script-format.ts';

test('adds greeting after the introduction and a complete outro when missing',()=>{
 const result=ensureChannelFraming('Erster Satz. Zweiter Satz! Dritter Satz. Hier folgt die Geschichte.');
 assert.match(result,/Erster Satz\. Zweiter Satz!\s+Willkommen bei Kontrakurs\.\s+Dritter Satz/);
 assert.match(result,/Like.*abonnier.*Kommentare.*(?:gut|Mal)/s);
});
test('preserves an existing greeting and complete call to action',()=>{
 const original='Erster Satz. Zweiter Satz. Hallo und willkommen bei Kontrakurs! Hier ist das Thema. Hinterlasst ein Like, abonniert den Kanal und schreibt eure Meinung in die Kommentare. Bis zum nächsten Mal!';
 assert.equal(ensureChannelFraming(original),original);
});
test('adds missing framing when punctuation is absent',()=>{
 const result=ensureChannelFraming('Ein kurzer Einstieg ohne Satzzeichen');
 assert.match(result,/Willkommen bei Kontrakurs/);
 assert.match(result,/abonnier/);
});
