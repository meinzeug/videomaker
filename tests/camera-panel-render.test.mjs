import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as policy from '../app/camera-panel-policy.ts';

// Static React rendering: this does not simulate browser events or HTTP.
const filename=new URL('../app/camera-panel-controls.tsx',import.meta.url).pathname;
const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const compiled=new Module(filename);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(new URL('../app/',import.meta.url).pathname);
const baseRequire=compiled.require.bind(compiled);compiled.require=(name)=>name==='./camera-panel-policy'?policy:baseRequire(name);compiled._compile(code,filename);
const Controls=compiled.exports.default;
const camera={id:'device',phase:'recording',recordingId:'take',projectId:'project',pendingStart:false,uncertain:false,capability:'remote-record-v4',paused:false,cameraFront:false,cameraCanSwitch:true};
function rendered(camera,busy=false,offline=false){const html=renderToStaticMarkup(React.createElement(Controls,{camera,projectId:'project',busy,offline,onControl:()=>{}}));return Object.fromEntries([...html.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].map(([,attrs,label])=>[label,!attrs.includes('disabled=""')]));}
test('rendered controls reflect actual device state and old device compatibility',()=>{
 assert.deepEqual(rendered(camera),{'Aufnahme pausieren':true,'Aufnahme fortsetzen':false,'Kamera wechseln':false});
 assert.deepEqual(rendered({...camera,paused:true}),{'Aufnahme pausieren':false,'Aufnahme fortsetzen':true,'Kamera wechseln':false});
 assert.deepEqual(rendered({...camera,phase:'idle',recordingId:null,projectId:null}),{'Aufnahme pausieren':false,'Aufnahme fortsetzen':false,'Kamera wechseln':true});
 for(const device of [{...camera,capability:null},{...camera,uncertain:true},{...camera,projectId:'other'}])assert.ok(Object.values(rendered(device)).every(enabled=>!enabled));
 assert.ok(Object.values(rendered(camera,false,true)).every(enabled=>!enabled));
});
