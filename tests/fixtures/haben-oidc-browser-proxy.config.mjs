import base from './haben-oidc-vitest.config.mjs';

// Runs only against the same explicitly marked, exclusive PostgreSQL fixture cluster.
export default {...base,test:{...base.test,include:['tests/fixtures/haben-oidc-browser-proxy.test.mjs']}};
