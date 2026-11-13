import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {CameraClock} from './camera-remote-store';

declare global { var __videomakerCameraClockId:string|undefined; }
/** Linux /proc/uptime is CLOCK_BOOTTIME, including suspend, truncated to 10 ms. */
export function parseBootUptime(value:string):number {
 const match=/^(\d+)\.(\d{2})\s/.exec(value);if(!match)throw new Error('Bootzeit nicht verfügbar.');
 const seconds=Number(match[1]),tick=seconds*1000+Number(match[2])*10;
 if(!Number.isSafeInteger(tick)||tick<0)throw new Error('Bootzeit ungültig.');return tick;
}
/** Shared across route bundles in this process; a restart invalidates old deadlines. */
export function cameraRemoteClock():CameraClock {
 const runtimeId=globalThis.__videomakerCameraClockId??=randomUUID();
 // Fail closed on non-Linux hosts or when procfs is unavailable; never fall back to suspend-blind hrtime.
 return {runtimeId,wall:Date.now(),tick:parseBootUptime(readFileSync('/proc/uptime','utf8'))};
}
