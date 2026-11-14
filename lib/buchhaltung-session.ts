import {createHash, timingSafeEqual} from 'node:crypto';

/** The caller receives no information about the browser session until this succeeds. */
export function internalSessionSecretValid(expected:string|undefined, supplied:string|null):boolean {
 if(!expected || expected.length<32 || expected.length>256 || !supplied || supplied.length>256)return false;
 const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest();
 return timingSafeEqual(digest(expected),digest(supplied));
}

export function internalSessionSecretConfigured(value:string|undefined):boolean {
 return typeof value==='string' && value.length>=32 && value.length<=256;
}
