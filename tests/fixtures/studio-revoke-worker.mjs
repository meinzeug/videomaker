import Database from 'better-sqlite3';
let data='';for await(const part of process.stdin)data+=part;const input=JSON.parse(data),db=new Database(input.path);db.pragma('busy_timeout=3000');
try{db.prepare('UPDATE synthetic_sessions SET active=0 WHERE session_hash=?').run(input.sessionHash);process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
