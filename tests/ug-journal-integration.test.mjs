// Run only against an isolated local server backed by a disposable DATA_DIR:
// UG_LEDGER_TEST_ORIGIN=http://127.0.0.1:3000 UG_LEDGER_TEST_PASSWORD=... \
//   UG_LEDGER_TEST_ALLOW_WRITE=1 node --test tests/ug-journal-integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.env.UG_LEDGER_TEST_ORIGIN;
const password = process.env.UG_LEDGER_TEST_PASSWORD;
const enabled = !!origin && !!password && process.env.UG_LEDGER_TEST_ALLOW_WRITE === '1';

test('journal HTTP authentication, origin checks, balanced posting, retries and reversal', { skip: !enabled }, async () => {
  const url = new URL(origin);
  assert.equal(url.protocol, 'http:', 'Only an isolated local HTTP test server is permitted');
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'Only an explicit loopback address is permitted');
  assert.equal(url.origin, origin, 'Origin must not contain a path, credentials, or trailing slash');
  const request = (path, options = {}) => fetch(new URL(path, origin), { redirect: 'manual', ...options });
  const anonymous = await request('/api/ledger/accounts');
  assert.equal(anonymous.status, 401);
  const login = await request('/api/login', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert.match(cookie, /kontrakurs_session=/);
  const get = path => request(path, { headers: { cookie } });
  const post = (path, body, requestOrigin = origin) => request(path, {
    method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase();
  const cash = { id: randomUUID(), code: `T${suffix}A`, name: 'Test Bank', kind: 'asset' };
  const revenue = { id: randomUUID(), code: `T${suffix}B`, name: 'Test Erlös', kind: 'income' };
  assert.equal((await post('/api/ledger/accounts', cash, 'http://example.invalid')).status, 403);
  for (const account of [cash, revenue]) {
    const created = await post('/api/ledger/accounts', account);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).account.id, account.id);
    const replay = await post('/api/ledger/accounts', account);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).created, false);
  }
  assert.equal((await post('/api/ledger/accounts', { ...cash, name: 'Changed' })).status, 409);
  const entry = {
    id: randomUUID(), occurredOn: '2026-01-01', description: 'Integrationstest',
    lines: [{ accountId: cash.id, side: 'debit', amountCents: 1275 }, { accountId: revenue.id, side: 'credit', amountCents: 1275 }],
  };
  const unbalanced = { ...entry, id: randomUUID(), lines: [entry.lines[0], { ...entry.lines[1], amountCents: 1274 }] };
  assert.equal((await post('/api/ledger/journals', unbalanced)).status, 400);
  let response = await post('/api/ledger/journals', entry);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).created, true);
  response = await post('/api/ledger/journals', entry);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).created, false);
  assert.equal((await post('/api/ledger/journals', { ...entry, description: 'Changed' })).status, 409);
  const balances = await (await get('/api/ledger/balances')).json();
  assert.equal(balances.balances.find(value => value.account.id === cash.id).netDebitCents, '1275');
  const reversal = { id: randomUUID(), occurredOn: '2026-01-02', reason: 'Integrationstest' };
  const reversePath = `/api/ledger/journals/${entry.id}/reverse`;
  response = await post(reversePath, reversal);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).journal.reversalOf, entry.id);
  response = await post(reversePath, reversal);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).created, false);
  assert.equal((await post(reversePath, { ...reversal, id: randomUUID() })).status, 409);
  const journals = await (await get('/api/ledger/journals')).json();
  assert.equal(journals.journals.filter(value => value.id === entry.id).length, 1);
  assert.equal(journals.journals.filter(value => value.id === reversal.id).length, 1);
  const finalBalances = await (await get('/api/ledger/balances')).json();
  assert.equal(finalBalances.balances.find(value => value.account.id === cash.id).netDebitCents, '0');
});
