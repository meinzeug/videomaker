import { logout, sameOrigin } from '@/lib/auth';
import { NextResponse } from 'next/server';
export async function POST(req:Request) { if(!await sameOrigin(req)) return NextResponse.json({error:'Ungültige Anfrage'},{status:403}); await logout(); return NextResponse.json({ok:true}); }
