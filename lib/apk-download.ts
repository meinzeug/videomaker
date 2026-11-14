import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';

/** The release publisher atomically replaces this fixed, application-private file. */
export const APK_FILENAME='kontraprompter.apk';
export const MAX_APK_BYTES=512*1024*1024;

/** Never follow a file symlink; a request cannot influence the release path. */
export async function openApkRelease(dataDir:string) {
 const file=await open(path.join(dataDir,APK_FILENAME),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await file.stat();
  if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<4||stat.size>MAX_APK_BYTES)throw new Error('Ungültiges APK-Paket.');
  // An APK is a ZIP archive. This is not an Android signature verification;
  // the publisher must verify the built APK before placing it here.
  const signature=Buffer.alloc(4);
  const {bytesRead}=await file.read(signature,0,4,0);
  if(bytesRead!==4||!signature.equals(Buffer.from([0x50,0x4b,0x03,0x04])))throw new Error('Ungültiges APK-Paket.');
  return {file,size:stat.size};
 }catch(error){await file.close();throw error;}
}
