import {createHash} from 'node:crypto';
import {open, stat} from 'node:fs/promises';
import path from 'node:path';
import {MAX_RECORDING_SIZE} from './recordings';

/** Hash the stored file itself, and reject replacement or mutation while reading. */
export async function recordingFileReceipt(filename:string, expectedSize:number, heartbeat:()=>void=()=>{}):Promise<{sizeBytes:number;sha256:string}> {
 if(!Number.isSafeInteger(expectedSize)||expectedSize<=0||expectedSize>MAX_RECORDING_SIZE)throw new Error('STORED_FILE_INVALID');
 const file=await open(filename,'r');
 try {
  const before=await file.stat();
  if(!before.isFile()||before.size!==expectedSize)throw new Error('STORED_FILE_INVALID');
  const hash=createHash('sha256');const buffer=Buffer.allocUnsafe(256*1024);let position=0;
  while(position<expectedSize){
   heartbeat();
   const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,expectedSize-position),position);
   if(bytesRead<=0)throw new Error('STORED_FILE_INVALID');
   hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
  }
  // Retry receipts must durably confirm older files too, not just newly uploaded ones.
  heartbeat();await file.sync();heartbeat();
  const directory=await open(path.dirname(filename),'r');
  try {await directory.sync();} finally {await directory.close();}
  heartbeat();const after=await file.stat();const current=await stat(filename);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs)throw new Error('STORED_FILE_CHANGED');
  return {sizeBytes:position,sha256:hash.digest('hex')};
 } finally {await file.close();}
}
