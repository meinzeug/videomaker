import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createOidcStorageAdapter, initializeOidcStorage } from '../../lib/oidc-storage.ts';

const testDirectory = process.env.OIDC_PROVIDER_TEST_DIR;
if (!testDirectory || !isAbsolute(testDirectory)) throw new Error('OIDC_PROVIDER_TEST_DIR muss ein separates absolutes Testverzeichnis sein.');
const testRequire = createRequire(join(testDirectory, 'package.json'));
const { Provider } = await import(pathToFileURL(testRequire.resolve('oidc-provider')).href);
const { createRemoteJWKSet, jwtVerify } = await import(pathToFileURL(testRequire.resolve('jose')).href);

const db = new Database(':memory:');
initializeOidcStorage(db);
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${server.address().port}`;
const clientSecret = 'nur-synthetisches-test-client-secret-123456789';
const redirect = 'http://127.0.0.1:12345/callback';
const provider = new Provider(issuer, {
  adapter: createOidcStorageAdapter(db),
  clients: [{ client_id: 'haben', client_secret: clientSecret, redirect_uris: [redirect], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_basic' }],
  features: { devInteractions: { enabled: false } },
  interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  findAccount: async (_ctx, accountId) => ({ accountId, claims: async () => ({ sub: accountId, email: 'test@example.invalid', email_verified: true, groups: ['haben-inhaber'] }) }),
  claims: { openid: ['sub'], profile: ['name'], email: ['email', 'email_verified'], groups: ['groups'] },
  scopes: ['openid', 'profile', 'email', 'groups'],
  pkce: { required: () => true, methods: ['S256'] },
});
server.on('request', async (req, res) => {
  if (!req.url.startsWith('/interaction/')) return provider.callback()(req, res);
  try {
    const interaction = await provider.interactionDetails(req, res);
    let result;
    if (interaction.prompt.name === 'login') result = { login: { accountId: 'test-inhaber' } };
    else if (interaction.prompt.name === 'consent') {
      const grant = new provider.Grant({ accountId: interaction.session.accountId, clientId: interaction.params.client_id });
      grant.addOIDCScope('openid profile email groups');
      result = { consent: { grantId: await grant.save() } };
    } else throw new Error(`Unbekannte Interaktion ${interaction.prompt.name}`);
    await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

try {
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let url = new URL('/auth', issuer);
  for (const [k,v] of Object.entries({client_id:'haben',redirect_uri:redirect,response_type:'code',scope:'openid profile email groups',state:'synthetischer-state',nonce:'synthetischer-nonce',code_challenge:challenge,code_challenge_method:'S256'})) url.searchParams.set(k,v);
  const cookies = new Map();
  for (let i=0; i<15 && url.origin === issuer; i++) {
    const response = await fetch(url, { redirect:'manual', headers: {cookie:[...cookies].map(([k,v]) => `${k}=${v}`).join('; ')} });
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const j=pair.indexOf('='); cookies.set(pair.slice(0,j),pair.slice(j+1)); }
    if (response.status !== 303 && response.status !== 302) throw new Error(`Unerwarteter HTTP-Status ${response.status}: ${await response.text()}`);
    url = new URL(response.headers.get('location'), url);
  }
  assert.equal(url.origin, 'http://127.0.0.1:12345');
  assert.equal(url.searchParams.get('state'), 'synthetischer-state');
  const code = url.searchParams.get('code');
  assert.ok(code);
  const auth = Buffer.from(`haben:${clientSecret}`).toString('base64');
  const exchange = (codeVerifier = verifier) => fetch(`${issuer}/token`, { method:'POST', headers:{authorization:`Basic ${auth}`,'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:codeVerifier}) });
  assert.equal((await exchange('f'.repeat(64))).status, 400);
  const first = await exchange();
  if (first.status !== 200) throw new Error(`Token-Tausch: ${first.status} ${await first.text()}`);
  const tokens = await first.json();
  assert.ok(tokens.id_token && tokens.access_token);
  const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {issuer, audience:'haben'});
  assert.equal(verified.payload.sub, 'test-inhaber');
  assert.equal(verified.payload.nonce, 'synthetischer-nonce');
  const profile = await fetch(discovery.userinfo_endpoint, {headers:{authorization:`Bearer ${tokens.access_token}`}});
  assert.equal(profile.status, 200);
  assert.deepEqual((await profile.json()).groups, ['haben-inhaber']);
  const replay = await exchange();
  assert.equal(replay.status, 400);
  console.log('Echter oidc-provider: Authorization Code + PKCE, Token-Ausgabe und Replay-Abwehr mit SQLite-Adapter erfolgreich.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
