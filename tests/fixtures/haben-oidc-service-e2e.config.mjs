import base from './haben-oidc-vitest.config.mjs';

// Explicitly disposable PostgreSQL only; the inherited setup verifies its marker and data_directory.
export default {...base,test:{...base.test,include:['tests/fixtures/haben-oidc-service-e2e.test.mjs']}};
