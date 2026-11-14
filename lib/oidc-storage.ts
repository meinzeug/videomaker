import type Database from 'better-sqlite3';

// Vorbereitender Baustein für oidc-provider; er wird von der Anwendung noch nicht verwendet.
// Die Datenbank enthält vertrauliche Protokolldaten und benötigt Betriebsschutz und Backups.
const schema = `
 CREATE TABLE IF NOT EXISTS oidc_records (
  model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  expires_at INTEGER, consumed_at INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
  PRIMARY KEY (model, id)
 );
 CREATE UNIQUE INDEX IF NOT EXISTS oidc_record_uid ON oidc_records(model, uid) WHERE uid IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS oidc_record_user_code ON oidc_records(model, user_code) WHERE user_code IS NOT NULL;
 CREATE INDEX IF NOT EXISTS oidc_record_grant ON oidc_records(grant_id) WHERE grant_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS oidc_revoked_grants (grant_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS oidc_consumed_objects (model TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(model,id));
 CREATE TABLE IF NOT EXISTS oidc_time_floor (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL);
 INSERT OR IGNORE INTO oidc_time_floor(id,observed_at) VALUES(1,0);
`;

type Payload = Record<string, unknown>;
type Row = { payload: string; consumed_at: number | null };

/** Nur auf einer ausdrücklich ausgewählten, separaten Datenbank ausführen. */
export function initializeOidcStorage(db: Database.Database): void { db.exec(schema); }

function identifier(value: unknown, label: string): string {
 if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new Error(`Ungültiges OIDC-Feld: ${label}`);
 return value;
}
function optionalIdentifier(value: unknown, label: string): string | null {
 return value == null ? null : identifier(value, label);
}

/** Adaptervertrag von oidc-provider; kein Aufruf und keine Schemaanlage beim Import. */
export function createOidcStorageAdapter(db: Database.Database, clock: () => number = Date.now) {
 const observedTime = (): number => {
  const sample = clock();
  if (!Number.isSafeInteger(sample) || sample < 0) throw new Error('Ungültige OIDC-Zeit');
  const row = db.prepare('UPDATE oidc_time_floor SET observed_at=MAX(observed_at,?) WHERE id=1 RETURNING observed_at').get(sample) as {observed_at:number} | undefined;
  if (!row) throw new Error('OIDC-Zeitmarkierung fehlt');
  return row.observed_at;
 };
 return class OidcStorageAdapter {
  private readonly model: string;
  constructor(model: string) { this.model = identifier(model, 'model'); }

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
   identifier(id, 'id');
   if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Ungültige OIDC-Daten');
   if (expiresIn !== undefined && (!Number.isSafeInteger(expiresIn) || expiresIn < 0)) throw new Error('Ungültige OIDC-Laufzeit');
   const serialized = JSON.stringify(payload);
   if (!serialized || Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Ungültige OIDC-Datengröße');
   const grantId = this.model === 'Grant' ? id : optionalIdentifier(payload.grantId, 'grantId');
   const uid = optionalIdentifier(payload.uid, 'uid');
   const userCode = optionalIdentifier(payload.userCode, 'userCode');
   const consumed = payload.consumed == null ? null : payload.consumed;
   if (consumed !== null && (!Number.isSafeInteger(consumed) || (consumed as number) < 0)) throw new Error('Ungültiger Verbrauchszeitpunkt');
   observedTime();
   db.transaction(() => {
    const current = observedTime();
    const expiry = expiresIn === undefined ? null : current + expiresIn * 1000;
    if (expiry !== null && !Number.isSafeInteger(expiry)) throw new Error('Ungültige OIDC-Zeit');
    if (grantId && db.prepare('SELECT 1 FROM oidc_revoked_grants WHERE grant_id = ?').get(grantId)) throw new Error('OIDC-Freigabe widerrufen');
    const previous = db.prepare('SELECT grant_id FROM oidc_records WHERE model=? AND id=?').get(this.model,id) as {grant_id:string | null} | undefined;
    if (previous && previous.grant_id !== grantId) {
     const firstAssignment = previous.grant_id === null && grantId !== null && ['DeviceCode','BackchannelAuthenticationRequest'].includes(this.model);
     if (!firstAssignment) throw new Error('OIDC-Freigabe darf nicht geändert werden');
    }
    if (db.prepare('SELECT 1 FROM oidc_records WHERE model=? AND id=? AND expires_at IS NOT NULL AND expires_at<=?').get(this.model,id,current)) {
     throw new Error('OIDC-Objekt bereits abgelaufen');
    }
    if (db.prepare(`SELECT 1 FROM oidc_consumed_objects WHERE model=? AND id=?
      AND NOT EXISTS (SELECT 1 FROM oidc_records WHERE model=? AND id=?)`).get(this.model,id,this.model,id)) {
     throw new Error('OIDC-Objekt bereits verbraucht');
    }
    // Alternative lookup values, especially short device user codes, can be
    // reused after expiry. Preserve the old record/ID and time floor so that
    // clearing these secondary indexes cannot make the expired object valid.
    if (uid !== null) db.prepare(`UPDATE oidc_records SET uid=NULL WHERE model=? AND uid=?
     AND expires_at IS NOT NULL AND expires_at<=?`).run(this.model,uid,current);
    if (userCode !== null) db.prepare(`UPDATE oidc_records SET user_code=NULL WHERE model=? AND user_code=?
     AND expires_at IS NOT NULL AND expires_at<=?`).run(this.model,userCode,current);
    if (consumed !== null) db.prepare('INSERT OR IGNORE INTO oidc_consumed_objects(model,id) VALUES(?,?)').run(this.model,id);
    db.prepare(`INSERT INTO oidc_records(model,id,payload,expires_at,consumed_at,grant_id,uid,user_code)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
     payload=excluded.payload,expires_at=excluded.expires_at,consumed_at=COALESCE(oidc_records.consumed_at,excluded.consumed_at),
     grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code`)
     .run(this.model,id,serialized,expiry,consumed,grantId,uid,userCode);
   }).immediate();
  }

  private load(field: 'id' | 'uid' | 'user_code', value: string): Payload | undefined {
   identifier(value, field);
   const row = db.transaction(() => db.prepare(`SELECT payload, consumed_at FROM oidc_records WHERE model=? AND ${field}=? AND (expires_at IS NULL OR expires_at>?)`)
    .get(this.model,value,observedTime()) as Row | undefined).immediate();
   if (!row) return undefined;
   const payload = JSON.parse(row.payload) as Payload;
   if (row.consumed_at !== null) payload.consumed = row.consumed_at;
   return payload;
  }
  async find(id: string): Promise<Payload | undefined> { return this.load('id',id); }
  async findByUid(uid: string): Promise<Payload | undefined> { return this.load('uid',uid); }
  async findByUserCode(code: string): Promise<Payload | undefined> { return this.load('user_code',code); }

  /** Nur ein konkurrierender Aufruf darf einen Code oder Token verbrauchen. */
  async consume(id: string): Promise<void> {
   identifier(id,'id');
   observedTime();
   db.transaction(() => {
    const now = observedTime();
    const result = db.prepare(`UPDATE oidc_records SET consumed_at=? WHERE model=? AND id=? AND consumed_at IS NULL
     AND (expires_at IS NULL OR expires_at>?)`).run(Math.floor(now/1000),this.model,id,now);
    if (result.changes !== 1) throw new Error('OIDC-Objekt fehlt, ist abgelaufen oder bereits verbraucht');
    db.prepare('INSERT OR IGNORE INTO oidc_consumed_objects(model,id) VALUES(?,?)').run(this.model,id);
   }).immediate();
  }
  async destroy(id: string): Promise<void> {
   identifier(id,'id');
   // A delayed writer must never restore an object whose deletion committed.
   // Also mark missing rows: an initial upsert may be in flight elsewhere.
   db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO oidc_consumed_objects(model,id) VALUES(?,?)').run(this.model,id);
    db.prepare('DELETE FROM oidc_records WHERE model=? AND id=?').run(this.model,id);
   }).immediate();
  }
  async revokeByGrantId(grantId: string): Promise<void> {
   identifier(grantId,'grantId');
   db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO oidc_revoked_grants(grant_id) VALUES(?)').run(grantId);
    // Individual object IDs must remain unusable even if a delayed write tries
    // to associate a previously revoked object with a different grant.
    db.prepare(`INSERT OR IGNORE INTO oidc_consumed_objects(model,id)
     SELECT model,id FROM oidc_records WHERE grant_id=?`).run(grantId);
    db.prepare('DELETE FROM oidc_records WHERE grant_id=?').run(grantId);
   }).immediate();
  }
 };
}
