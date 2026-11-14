import {readFileSync} from 'node:fs';

/** Linux boot identity and boot-time clock are shared by workers on one host. */
export function relayClock(){
 const runtimeId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim().toLowerCase();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runtimeId))throw new Error('RELAY_CLOCK_UNAVAILABLE');
 const match=/^(\d+)\.(\d{2})\s/.exec(readFileSync('/proc/uptime','utf8'));
 if(!match)throw new Error('RELAY_CLOCK_UNAVAILABLE');
 const tick=Number(match[1])*1000+Number(match[2])*10,wall=Date.now();
 if(!Number.isSafeInteger(tick)||tick<0||!Number.isSafeInteger(wall)||wall<0)throw new Error('RELAY_CLOCK_UNAVAILABLE');
 return {runtimeId,wall,tick};
}
