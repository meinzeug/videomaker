import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer,request} from 'node:https';
import {fetchSelectedSources,extractSourceText,publicIPv4,SourceFetchBusy} from '../lib/selected-source-fetch.ts';

const source=(url)=>({title:'Artikel',url,source:'Quelle',date:'',description:'Kurzer Hinweis'});

test('rejects nonpublic addresses and unsafe literals',()=>{
 for(const ip of ['127.0.0.1','0.2.3.4','10.0.0.1','172.16.0.1','172.31.255.1','192.168.1.1','100.64.0.1','169.254.169.254','198.18.0.1','192.0.2.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
});

test('HTML extraction remains bounded for malformed unclosed tags',()=>{
 const start=performance.now();
 assert.equal(extractSourceText('<script>'.repeat(120000),true),'');
 assert.equal(extractSourceText('<'.repeat(1000000),true),'');
 assert.ok(performance.now()-start<2500,'unclosed tags must not cause quadratic work');
 assert.equal(extractSourceText('<head>hidden</head><p>Hallo &amp; Welt</p><script>evil()</script>',true),'Hallo & Welt');
});

test('only pinned public DNS addresses are contacted and TLS hostname is verified',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-tls-test-'));let server;
 try{
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=source.example','-addext','subjectAltName=DNS:source.example'],{stdio:'ignore'});
  const ca=readFileSync(cert);
  server=createServer({key:readFileSync(key),cert:ca},(req,res)=>{
   if(req.url==='/redirect'){res.writeHead(302,{location:'https://other.example/news'});res.end();return;}
   if(req.url==='/large'){res.writeHead(200,{'content-type':'text/plain','content-length':String(1024*1024+1)});res.end('x');return;}
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<p>'+('Ausgewählter Artikeltext. '.repeat(8))+'</p>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,seen=[];
  const deps={resolver:()=>({resolve4:async()=>['8.8.8.8'],cancel(){}}),request:(options,callback)=>{seen.push(options);return request({...options,hostname:'127.0.0.1',port,ca},callback);}};
  let result=await fetchSelectedSources([source('https://source.example/story')],deps);
  assert.equal(result[0].status,'retrieved');assert.match(result[0].text,/Ausgewählter Artikeltext/);
  assert.equal(seen[0].hostname,'8.8.8.8');assert.equal(seen[0].servername,'source.example');assert.equal(seen[0].rejectUnauthorized,true);assert.equal(seen[0].agent,false);
  result=await fetchSelectedSources([source('https://wrong.example/story')],deps);assert.equal(result[0].status,'unavailable');
  const before=seen.length;result=await fetchSelectedSources([source('https://source.example/redirect')],deps);assert.equal(result[0].status,'unavailable');assert.equal(seen.length,before+1);
  result=await fetchSelectedSources([source('https://source.example/large')],deps);assert.equal(result[0].status,'unavailable');
  const blocked={...deps,resolver:()=>({resolve4:async()=>['8.8.8.8','127.0.0.1'],cancel(){}})};
  const count=seen.length;result=await fetchSelectedSources([source('https://source.example/story')],blocked);assert.equal(result[0].status,'unavailable');assert.equal(seen.length,count);
  for(const bad of ['https://127.0.0.1/a','https://user:pass@source.example/a','https://source.example:444/a','http://source.example/a','https://test.local/a']){
   result=await fetchSelectedSources([source(bad)],deps);assert.equal(result[0].status,'unavailable',bad);
  }
 }finally{if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('bounded concurrent lookups fail closed and timeout cancels them',async()=>{
 let cancelled=0;
 const deps={timeoutMs:40,resolver:()=>{let reject;return {resolve4:()=>new Promise((_,r)=>{reject=r;}),cancel:()=>{cancelled++;reject?.(new Error('cancelled'));}};},request:()=>{throw new Error('must not send');}};
 const keepAlive=setTimeout(()=>{},1000);
 try{
 const running=Array.from({length:8},(_,i)=>fetchSelectedSources([source(`https://source${i}.example/story`)],deps));
 await assert.rejects(fetchSelectedSources([source('https://extra.example/story')],deps),SourceFetchBusy);
 await Promise.all(running);assert.equal(cancelled,8);
 }finally{clearTimeout(keepAlive);}
});
