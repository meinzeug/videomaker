import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// This is a static React render, not an interactive browser or network test.
const filename=new URL('../app/image-choice-dialog.tsx',import.meta.url).pathname;
const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const compiled=new Module(filename);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(new URL('../app/',import.meta.url).pathname);compiled._compile(code,filename);
const Dialog=compiled.exports.default;
const noop=()=>{};
const props={title:'Fixture',sources:[{title:'Quelle A',url:'https://a.invalid',source:'A'},{title:'Quelle B',url:'https://b.invalid',source:'B'}],channels:[{id:'channel-fixture',name:'Kanal',platform:'Test',handle:''}],initial:{imageMode:'descriptions',channelId:'channel-fixture',selectedIndexes:[1],options:{mode:'commentary',scope:'selected',tones:['frech','sachlich'],dramaturgy:'Dramaturgie Probe',instructions:'Hinweis Probe',allowIncompleteSources:true}},onClose:noop,onConfirm:noop,onReauthenticate:noop,onReviewStatus:noop};
function controls(html){return [...html.matchAll(/<(?:input|textarea|option)\b[^>]*>(?:[^<]*<\/textarea>)?/g)].map(match=>match[0]);}
test('render retains all draft controls through session notice and uncertain guard',()=>{
 const before=renderToStaticMarkup(React.createElement(Dialog,props));
 const expired=renderToStaticMarkup(React.createElement(Dialog,{...props,sessionExpired:true}));
 const uncertain=renderToStaticMarkup(React.createElement(Dialog,{...props,generationUncertain:true}));
 assert.deepEqual(controls(expired),controls(before));assert.deepEqual(controls(uncertain),controls(before));
 assert.match(before,/<option value="channel-fixture" selected="">/);assert.match(before,/Dramaturgie Probe/);assert.match(before,/Hinweis Probe/);
 assert.match(expired,/Erneut anmelden/);assert.match(uncertain,/Status prüfen/);assert.match(uncertain,/Web-Recherche kann Kosten verursacht haben/);assert.match(uncertain,/disabled=""[^>]*>Skript erstellen/);
});
