/* Read-only local migration aid. Nothing is uploaded or removed. */
(() => {
  'use strict';
  const databaseNames = ['videomaker-finance-outbox', 'videomaker-ug-journal-outbox'];
  const storeName = 'operations';
  const status = document.getElementById('status');
  const check = document.getElementById('check');
  const save = document.getElementById('save');
  let snapshot = null;

  function readDatabase(name) {
    return new Promise((resolve, reject) => {
      let absent = false, settled = false;
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
      request.onblocked = () => { settled = true; reject(new Error('Der lokale Speicher wird von einem anderen Tab blockiert.')); };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        if (absent) resolve([]);
        else reject(request.error || new Error('Der lokale Speicher konnte nicht gelesen werden.'));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        if (!database.objectStoreNames.contains(storeName)) { database.close(); settled = true; reject(new Error('Eine Warteschlange hat ein unbekanntes Speicherformat.')); return; }
        let records;
        try {
          const transaction = database.transaction(storeName, 'readonly');
          const get = transaction.objectStore(storeName).getAll();
          get.onsuccess = () => { records = get.result; };
          transaction.oncomplete = () => { database.close(); settled = true; resolve(records); };
          transaction.onabort = () => { database.close(); settled = true; reject(transaction.error || new Error('Die Warteschlange konnte nicht vollständig gelesen werden.')); };
          transaction.onerror = () => {};
        } catch (error) { database.close(); settled = true; reject(error); }
      };
    });
  }

  async function encode(value, ancestors = new Set()) {
    if (value === undefined) return {type:'undefined'};
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return {type:'value', value};
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return {type:'value', value};
    if (typeof value === 'bigint') return {type:'bigint', value:String(value)};
    if (value instanceof Blob) {
      const blob = value;
      const isFile = typeof File !== 'undefined' && value instanceof File;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 24576) binary += String.fromCharCode(...bytes.subarray(i, i + 24576));
      return {type:isFile ? 'file' : 'blob', mime:blob.type, size:bytes.length,
        ...(isFile ? {name:value.name, lastModified:value.lastModified} : {}), base64:btoa(binary)};
    }
    if (value instanceof Date) return {type:'date', value:value.toISOString()};
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Ein gespeicherter Vorgang enthält ein nicht unterstütztes oder zyklisches Format.');
    const next = new Set(ancestors); next.add(value);
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error('Ein gespeicherter Vorgang enthält ein nicht unterstütztes Array.');
      return {type:'array', value:await Promise.all(value.map(item => encode(item, next)))};
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Ein gespeicherter Vorgang enthält ein nicht unterstütztes Format.');
    const entries=[];
    for (const [key, item] of Object.entries(value)) entries.push([key, await encode(item, next)]);
    return {type:'object', value:entries};
  }

  check.addEventListener('click', async () => {
    check.disabled = true; save.disabled = true; snapshot = null; status.textContent = 'Lokale Warteschlangen werden gelesen …';
    try {
      if (typeof indexedDB === 'undefined') throw new Error('Der lokale Speicher ist in diesem Browser nicht verfügbar.');
      const records = await Promise.all(databaseNames.map(readDatabase));
      snapshot = {format:'videomaker-legacy-outboxes-v1', exportedAt:new Date().toISOString(),
        databases:await Promise.all(records.map(async (items, i) => ({name:databaseNames[i], records:await Promise.all(items.map(item => encode(item)))})))};
      const total = records.reduce((sum, items) => sum + items.length, 0);
      status.textContent = total ? `${total} lokale Vorgänge gefunden. Die Sicherung enthält auch vorhandene Belegdateien.` : 'Keine lokalen Vorgänge in diesem Browserprofil gefunden.';
      save.disabled = total === 0;
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Lokale Vorgänge konnten nicht gelesen werden.'; }
    finally { check.disabled = false; }
  });
  save.addEventListener('click', () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `videomaker-lokale-vorgaenge-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    status.textContent = 'Der lokale Download wurde gestartet. Die Warteschlangen bleiben unverändert.';
  });
})();
