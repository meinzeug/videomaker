import base from './haben-oidc-vitest.config.mjs';

// Explicit disposable PostgreSQL cluster; the inherited setup validates its identity before dropping test databases.
export default {...base,test:{...base.test,include:['tests/fixtures/haben-agency-links.test.mjs']}};
