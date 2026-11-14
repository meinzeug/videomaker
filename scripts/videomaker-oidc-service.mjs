import { createServer } from 'node:http';
import { createOidcBindingClient } from '../lib/oidc-binding-client.ts';
import { openProviderDatabase } from '../lib/oidc-provider-database.mjs';
import { createVideomakerOidcService,validateVideomakerOidcConfig } from '../lib/videomaker-oidc-service.mjs';

/** No secrets are printed, generated, stored in source, or sent to a browser. */
function configuration(env) {
 let jwks,cookieKeys;
 try{jwks=JSON.parse(env.VIDEOMAKER_OIDC_JWKS||'');cookieKeys=JSON.parse(env.VIDEOMAKER_OIDC_COOKIE_KEYS||'');}
 catch{throw new Error('OIDC-Schlüsselkonfiguration ist ungültig');}
 return validateVideomakerOidcConfig({issuer:env.VIDEOMAKER_OIDC_ISSUER,redirect:env.VIDEOMAKER_OIDC_REDIRECT,clientId:env.VIDEOMAKER_OIDC_CLIENT_ID,
  clientSecret:env.VIDEOMAKER_OIDC_CLIENT_SECRET,subject:env.VIDEOMAKER_OIDC_SUBJECT,email:env.VIDEOMAKER_OIDC_EMAIL,
  cacheKey:env.VIDEOMAKER_OIDC_CACHE_KEY,cookieKeys,jwks});
}

let db;
try{
 const config=configuration(process.env),port=Number(process.env.VIDEOMAKER_OIDC_PORT);
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Ungültiger lokaler OIDC-Port');
 const binding=createOidcBindingClient({endpoint:process.env.VIDEOMAKER_OIDC_BINDING_URL,secret:process.env.VIDEOMAKER_OIDC_BINDING_SECRET,caFile:process.env.VIDEOMAKER_OIDC_BINDING_CA});
 db=openProviderDatabase(process.env.VIDEOMAKER_OIDC_DATABASE);
 const service=createVideomakerOidcService(config,{db,binding});
 const server=createServer((req,res)=>void service.handle(req,res));
 server.listen(port,'127.0.0.1',()=>console.log('OIDC-Dienst auf lokalem Loopback gestartet.'));
 let stopping=false;
 const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{db.close();});};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 server.on('error',()=>{console.error('OIDC-Dienst konnte nicht gestartet werden.');if(!stopping){stopping=true;db.close();}process.exitCode=1;});
}catch{db?.close();console.error('OIDC-Dienst nicht gestartet. Konfiguration und Datenbank prüfen.');process.exitCode=1;}
