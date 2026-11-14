import {createHmac, randomUUID} from 'node:crypto';

/**
 * TURN REST credentials are reusable until expiry: WebRTC may need several
 * allocations and refreshes. This function does not authenticate a device,
 * grant relay access by itself, read configuration, or expose an HTTP route.
 */
export type TurnRestCredential = {username:string; credential:string; expiresAt:number};

export function issueTurnRestCredential(
 secret:Uint8Array,
 nowSeconds:number,
 ttlSeconds:number,
 opaqueId:string = randomUUID(),
):TurnRestCredential {
 if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 4096) throw new Error('Invalid TURN secret');
 if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 3600) throw new Error('Invalid TURN lifetime');
 const expiresAt=nowSeconds+ttlSeconds;
 if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid TURN lifetime');
 if (typeof opaqueId!=='string' || opaqueId.length!==36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(opaqueId)) throw new Error('Invalid TURN identity');
 const username=`${expiresAt}:${opaqueId}`;
 const credential=createHmac('sha1',secret).update(username,'utf8').digest('base64');
 return {username,credential,expiresAt};
}
