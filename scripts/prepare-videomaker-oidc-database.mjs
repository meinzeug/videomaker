import { initializeProviderDatabase } from '../lib/oidc-provider-database.mjs';

if(process.env.VIDEOMAKER_OIDC_CREATE_DATABASE!=='1'||!process.env.VIDEOMAKER_OIDC_DATABASE) {
 console.error('Eine neue OIDC-Datenbank erfordert VIDEOMAKER_OIDC_CREATE_DATABASE=1 und einen absoluten VIDEOMAKER_OIDC_DATABASE-Pfad.');
 process.exitCode=1;
}else {
 try{initializeProviderDatabase(process.env.VIDEOMAKER_OIDC_DATABASE);console.log('Separate OIDC-Datenbank vorbereitet.');}
 catch(error){console.error(`OIDC-Datenbank nicht vorbereitet: ${error instanceof Error?error.message:'Fehler'}`);process.exitCode=1;}
}
