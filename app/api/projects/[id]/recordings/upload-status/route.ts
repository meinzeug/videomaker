import { authorized } from '@/lib/auth';
import db from '@/lib/db';
import { isRecordingId } from '@/lib/recordings';
import { PROJECT_RECORDING_DELETION_SCHEMA, isRecordingTombstoned } from '@/lib/project-recording-deletions';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store' };

/** Advisory lookup after a broken stream. POST still rechecks under its own lock. */
export async function GET(req: Request, { params }: Context) {
  if (!await authorized()) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401, headers });
  const { id } = await params;
  const values = new URL(req.url).searchParams.getAll('recordingId');
  const recordingId = values.length === 1 ? values[0].toLowerCase() : '';
  if (!isRecordingId(recordingId)) return NextResponse.json({ error: 'Ungültige Aufnahme-ID.' }, { status: 400, headers });
  try {
    const database = db();
    if (!database.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) return NextResponse.json({ error: 'Skript nicht gefunden' }, { status: 404, headers });
    database.exec(PROJECT_RECORDING_DELETION_SCHEMA);
    if (isRecordingTombstoned(database, recordingId)) return NextResponse.json({ code: 'recording_deleted', error: 'Diese Aufnahme wurde gelöscht. Für eine neue Aufnahme ist eine neue Aufnahme-ID erforderlich.' }, { status: 409, headers });
    return new Response(null, { status: 204, headers });
  } catch {
    return NextResponse.json({ error: 'Aufnahmeschutz ist auf diesem Server nicht verfügbar.' }, { status: 503, headers });
  }
}
