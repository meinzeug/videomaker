import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';

const require=createRequire(new URL('../../apps/buchhaltung/package.json',import.meta.url));

// Only opt-in against a disposable PostgreSQL cluster. The upstream global setup
// drops and recreates test databases; the caller must never point it at real data.
export default {
 root:fileURLToPath(new URL('../..',import.meta.url)),
 base:'/buchhaltung/',
 resolve:{alias:{vitest:join(dirname(require.resolve('vitest/package.json')),'dist/index.js')}},
 test:{
  include:['tests/fixtures/haben-oidc-integration.test.mjs'],
  globalSetup:['tests/fixtures/haben-oidc-safety.mjs'],
  maxWorkers:1,
  fileParallelism:false,
 },
};
