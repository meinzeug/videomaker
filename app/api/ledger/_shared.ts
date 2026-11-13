import {NextResponse} from 'next/server';
import {LedgerConflict,LedgerNotFound,LedgerValidationError} from '@/lib/ug-ledger';

export const noStore={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export class InvalidLedgerBody extends Error {}
/** Bound the streamed body too: Content-Length alone can be absent or false. */
export async function readLedgerJson(request:Request):Promise<unknown>{
 const length=request.headers.get('content-length');
 if(length&&(!/^\d+$/.test(length)||Number(length)>65536))throw new InvalidLedgerBody('Anfrage ist zu groß.');
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!request.body)throw new InvalidLedgerBody('Ungültige Anfrage.');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new InvalidLedgerBody('Anfrage ist zu groß.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 try{const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{throw new InvalidLedgerBody('Ungültige JSON-Anfrage.');}
}
export function ledgerError(error:unknown){
 if(error instanceof InvalidLedgerBody||error instanceof LedgerValidationError)return NextResponse.json({error:error.message},{status:400,headers:noStore});
 if(error instanceof LedgerNotFound)return NextResponse.json({error:error.message},{status:404,headers:noStore});
 if(error instanceof LedgerConflict)return NextResponse.json({error:error.message},{status:409,headers:noStore});
 console.error('Journalanfrage konnte nicht verarbeitet werden.');
 return NextResponse.json({error:'Journalanfrage konnte nicht verarbeitet werden.'},{status:500,headers:noStore});
}
