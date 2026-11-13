// Test-only preload: never inject faults in production or outside an explicit fixture.
const fs = require('node:fs');
const path = require('node:path');
const {syncBuiltinESMExports} = require('node:module');
const dir = process.env.DATA_DIR || '';
if (process.env.NODE_ENV === 'development' && process.env.VIDEOMAKER_UPLOAD_FAULT_INJECT === '1' && dir.startsWith('/tmp/videomaker-upload-fault-fixture-')) {
 const original = fs.fsyncSync;
 const recordings = path.join(dir, 'recordings');
 const trigger = path.join(recordings, '.test-fail-linked-file-fsync');
 fs.fsyncSync = function(fd) {
  try {
   const destination = fs.readlinkSync(`/proc/self/fd/${fd}`);
   if (destination === recordings && fs.existsSync(trigger)) {
    const id = fs.readFileSync(trigger, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(id) && fs.existsSync(path.join(recordings, `${id}.mp4`))) {
     fs.unlinkSync(trigger);
     const error = new Error('Synthetic fsync failure'); error.code = 'EIO'; throw error;
    }
   }
  } catch (error) {if(error && error.code === 'EIO')throw error;}
  return original.call(this,fd);
 };
 syncBuiltinESMExports();
}
