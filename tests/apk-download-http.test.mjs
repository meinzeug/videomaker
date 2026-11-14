// Exercise the real route handlers over loopback with synthetic authentication and APK bytes.
// This is not a Next.js middleware or browser end-to-end test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {openApkRelease} from '../lib/apk-download.ts';
import {APK_DOWNLOAD_NAME} from '../lib/apk-download-name.ts';
const require=createRequire(import.meta.url),ts=require('typescript');
function loadTs(file,stubs,jsx=false){
 const source=readFileSync(resolve(file),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:jsx?ts.JsxEmit.ReactJSX:undefined}}).outputText;
 const module={exports:{}};const localRequire=name=>Object.hasOwn(stubs,name)?stubs[name]:require(name);
 runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:file})(localRequire,module,module.exports);
 return module.exports;
}

test('real APK handlers preserve authorization, neutral names and bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vm-apk-http-')),old=process.env.DATA_DIR,bytes=Buffer.from([0x50,0x4b,0x03,0x04,0x42,0x75,0x69,0x6c,0x64]);
 process.env.DATA_DIR=dir;writeFileSync(join(dir,'kontraprompter.apk'),bytes);
 const routes=loadTs('app/api/apk/route.ts',{'@/lib/auth':{authorized:async()=>allowed},'@/lib/apk-download':{openApkRelease},'@/lib/apk-download-name':{APK_DOWNLOAD_NAME},'next/server':{NextResponse:{json:(value,options)=>Response.json(value,options)}}});
 let allowed=false;const server=createServer(async(req,res)=>{try{const response=await routes[req.method]();res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();}catch{res.writeHead(500);res.end();}});
 try{
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const origin=`http://127.0.0.1:${server.address().port}`;
  for(const method of ['HEAD','GET'])assert.equal((await fetch(origin+'/api/apk',{method})).status,401);
  allowed=true;const head=await fetch(origin+'/api/apk',{method:'HEAD'}),get=await fetch(origin+'/api/apk');
  for(const response of [head,get]){assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),'attachment; filename="KontraPrompter.apk"');assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(response.headers.get('content-type'),'application/vnd.android.package-archive');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');}
  assert.equal((await head.arrayBuffer()).byteLength,0);assert.deepEqual(Buffer.from(await get.arrayBuffer()),bytes);
  unlinkSync(join(dir,'kontraprompter.apk'));assert.equal((await fetch(origin+'/api/apk',{method:'HEAD'})).status,404);
 }finally{await new Promise(ok=>server.close(ok));if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test('download button exposes an accessible neutral Android label',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const component=loadTs('app/apk-download.tsx',{'@/lib/apk-download-name':{APK_DOWNLOAD_NAME}},true).default;
 const html=renderToStaticMarkup(React.createElement(component,{onError:()=>{}}));
 assert.match(html,/aria-label="KontraPrompter für Android herunterladen"/);assert.match(html,/>APK<\/span>/);assert.doesNotMatch(html,/DEBUG|Testversion/);
});
