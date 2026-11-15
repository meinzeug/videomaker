// Disposable local streaming reverse proxy, never a production listener.
import http from 'node:http';
if(process.env.DELETION_TEST_ALLOW_WRITES!=='1')throw Error('isolated fixture only');
const server=http.createServer((incoming,outgoing)=>{
 const upstream=http.request({host:'127.0.0.1',port:3333,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{
  outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);
 });
 upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
 incoming.on('aborted',()=>upstream.destroy());outgoing.on('close',()=>{if(!outgoing.writableFinished)upstream.destroy();});
 incoming.pipe(upstream);
});
server.listen(3332,'127.0.0.1');
