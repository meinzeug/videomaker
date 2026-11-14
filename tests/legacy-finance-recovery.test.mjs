import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/legacy-finance-recovery.js', import.meta.url), 'utf8');

function browser(setup) {
  const context = vm.createContext({Blob, Uint8Array, ArrayBuffer, btoa, queueMicrotask, setTimeout: () => 0});
  vm.runInContext(`
    const elements = Object.fromEntries(['status','check','save'].map(id => [id, {
      disabled: id === 'save', textContent: '', addEventListener(type, fn) { this[type] = fn; }
    }]));
    let downloaded, clicked = 0, transactions = [], closes = 0;
    const URL = {createObjectURL(blob) { downloaded = blob; return 'blob:local'; }, revokeObjectURL() {}};
    const document = {getElementById(id) { return elements[id]; }, body:{appendChild(){}},
      createElement() {return {click(){clicked++}, remove(){}}}};
    const data = Object.create(null);
    ${setup}
    const indexedDB = {open(name) {
      const request = {};
      queueMicrotask(() => {
        const database = data[name];
        if (!database) {
          request.transaction = {abort() {queueMicrotask(() => request.onerror());}};
          request.onupgradeneeded();
          return;
        }
        request.result = {
          objectStoreNames:{contains(name) {return database.store !== false && name === 'operations';}},
          close() {closes++},
          transaction(name, mode) {
            transactions.push([name, mode]);
            const transaction = {objectStore() {return {getAll() {
              const get = {};
              queueMicrotask(() => {get.result = database.records; get.onsuccess(); queueMicrotask(() => transaction.oncomplete());});
              return get;
            }}}};
            return transaction;
          }
        };
        request.onsuccess();
      });
      return request;
    }};
  `, context);
  vm.runInContext(script, context);
  return {context, run: code => vm.runInContext(code, context)};
}

test('exports both read-only outboxes including exact attachment bytes', async () => {
  const b = browser(`
    data['videomaker-finance-outbox'] = {records:[{id:'doc', blob:new Blob([new Uint8Array([0,1,255])], {type:'image/png'})}]};
    data['videomaker-ug-journal-outbox'] = {records:[{key:'active',item:{amount:42}}]};
  `);
  await b.run('elements.check.click()');
  assert.match(b.run('elements.status.textContent'), /2 lokale Vorgänge/);
  assert.equal(b.run('elements.save.disabled'), false);
  b.run('elements.save.click()');
  const saved = JSON.parse(await b.run('downloaded').text());
  assert.equal(saved.format, 'videomaker-legacy-outboxes-v1');
  const doc = Object.fromEntries(saved.databases[0].records[0].value);
  assert.deepEqual(doc.blob, {type:'blob', mime:'image/png', size:3, base64:'AAH/'});
  assert.equal(saved.databases[1].records.length, 1);
  assert.deepEqual(JSON.parse(b.run('JSON.stringify(transactions)')), [['operations','readonly'], ['operations','readonly']]);
  assert.equal(b.run('closes'), 2);
  assert.equal(b.run('clicked'), 1);
});

test('missing databases are not created and yield no downloadable data', async () => {
  const b = browser('');
  await b.run('elements.check.click()');
  assert.match(b.run('elements.status.textContent'), /Keine lokalen Vorgänge/);
  assert.equal(b.run('elements.save.disabled'), true);
  assert.equal(b.run('Object.keys(data).length'), 0);
});

test('unknown store and unsupported data prevent a partial export', async () => {
  for (const setup of [
    "data['videomaker-finance-outbox']={store:false,records:[]};",
    "data['videomaker-finance-outbox']={records:[{value:new Map()}]};",
    "data['videomaker-finance-outbox']={records:[{value:-0}]};"
  ]) {
    const b = browser(setup);
    await b.run('elements.check.click()');
    assert.match(b.run('elements.status.textContent'), /unbekanntes|nicht unterstütztes/);
    assert.equal(b.run('elements.save.disabled'), true);
    b.run('elements.save.click()');
    assert.equal(b.run('downloaded'), undefined);
  }
});
