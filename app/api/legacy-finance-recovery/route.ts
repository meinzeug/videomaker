import {authorized} from '@/lib/auth';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';

/** One-time, read-only migration aid; all browser data stays on the device. */
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers:{'Cache-Control':'private, no-store'}});
 const page=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lokale Vorgänge sichern</title><style>body{font:16px system-ui,sans-serif;color:#171717;max-width:50rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.7rem 1rem;margin:.3rem .5rem .3rem 0}#status{white-space:pre-wrap}</style></head><body><main><h1>Lokale Vorgänge sichern</h1><p>Dieses einmalige Werkzeug prüft die früheren Warteschlangen in diesem Browserprofil. Es verändert und überträgt keine gespeicherten Daten. Falls Vorgänge vorhanden sind, kannst du eine lokale Sicherungsdatei einschließlich Belegen herunterladen.</p><p>Die Sicherung ist kein automatischer Import in Haben. Prüfe weitere verwendete Browserprofile separat.</p><button id="check" type="button">Vorgänge prüfen</button><button id="save" type="button" disabled>Sicherung herunterladen</button><p id="status" role="status" aria-live="polite">Noch nicht geprüft.</p></main><script src="/legacy-finance-recovery.js" defer></script></body></html>`;
 return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}
