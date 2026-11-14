import { createHmac, timingSafeEqual } from 'node:crypto';

/** Shared, side-effect-free verification of Video-Maker's existing cookie format. */
export function signSessionBody(body:string,secret:string):string {
 return createHmac('sha256',secret).update(body).digest('base64url');
}
export function validSessionSignature(value:string,secret:string):boolean {
 const parts=value.split('.');
 if(parts.length!==3)return false;
 const expected=Buffer.from(signSessionBody(`${parts[0]}.${parts[1]}`,secret)),actual=Buffer.from(parts[2]);
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
export function sessionCookieValid(value:string,secret:string|undefined,now:number=Date.now()):boolean {
 if(!secret||secret.length<32)return false;
 const parts=value.split('.');
 return parts.length===3&&Number(parts[0])>now&&validSessionSignature(value,secret);
}
