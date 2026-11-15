import Database from 'better-sqlite3';
import {legacyUploadOriginReport} from '../lib/legacy-upload-origin-report.ts';

// No default path: a caller must explicitly supply an already reviewed copy.
if(process.argv.length!==3)throw new Error('A reviewed database-copy path is required');
const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});
try { process.stdout.write(JSON.stringify(legacyUploadOriginReport(db))+'\n'); }
finally { db.close(); }
