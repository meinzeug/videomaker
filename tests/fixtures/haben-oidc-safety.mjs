import {readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Refuse to let Haben's destructive test setup touch any unmarked cluster. */
export async function setup(){
 const root=process.env.HABEN_OIDC_DISPOSABLE_CLUSTER,urlText=process.env.TEST_DATABASE_URL;
 if(process.env.HABEN_OIDC_ALLOW_DISPOSABLE_WRITES!=='1'||!root||!isAbsolute(root)||!urlText)throw new Error('Nur explizit freigegebener isolierter Haben-OIDC-Testcluster erlaubt.');
 if(await readFile(join(root,'.videomaker-haben-oidc-test'),'utf8')!=='VIDEOMAKER HABEN OIDC TEST ONLY\n')throw new Error('Testcluster-Markierung fehlt.');
 const url=new URL(urlText);
 if(url.protocol!=='postgres:'||url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1024||url.pathname!=='/videomaker_haben_fixture'||url.search||url.hash)throw new Error('Ungültige isolierte Testdatenbank.');
 const require=createRequire(new URL('../../apps/buchhaltung/apps/web/package.json',import.meta.url));
 const {default:postgres}=await import(pathToFileURL(require.resolve('postgres')).href);
 const connection=postgres(urlText,{max:1,connect_timeout:3});
 try{
  const [row]=await connection`select current_setting('data_directory') as directory`;
  if(await realpath(row.directory)!==await realpath(join(root,'data')))throw new Error('PostgreSQL-Datenverzeichnis gehört nicht zum Testcluster.');
 }finally{await connection.end();}
 // Import and run upstream's database-dropping setup only after all checks pass.
 const upstream=await import('../../apps/buchhaltung/apps/web/src/server/test-db.ts');
 await upstream.setup();
}
