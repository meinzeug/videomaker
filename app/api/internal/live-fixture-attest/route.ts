import {NextResponse} from 'next/server';

/** Test harness attestation only. It is unreachable without an isolated dev environment. */
export const dynamic='force-dynamic';
export async function GET(){
 const proof=process.env.LIVE_RECORDING_FIXTURE_PROOF;
 if(process.env.NODE_ENV==='production'||process.env.LIVE_RECORDING_UPLOAD_TEST_ENABLE!=='1'||!proof||!/^[a-f0-9]{64}$/.test(proof))
  return NextResponse.json({error:'Nicht gefunden.'},{status:404,headers:{'Cache-Control':'no-store'}});
 return NextResponse.json({proof},{headers:{'Cache-Control':'no-store'}});
}
