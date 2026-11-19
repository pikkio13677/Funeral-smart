'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertTenantCutoverReady = require('../tenant-cutover-guard');

test('keeps the dormant tenant API disabled by default', () => {
  assert.doesNotThrow(() => assertTenantCutoverReady({ ENABLE_MULTI_TENANT: 'false' }));
  assert.doesNotThrow(() => assertTenantCutoverReady({}));
});

test('blocks multi-tenant mode unless the separate cutover approval is explicit', () => {
  assert.throws(
    () => assertTenantCutoverReady({ ENABLE_MULTI_TENANT: 'true' }),
    /MULTI_TENANT_CUTOVER_APPROVED/
  );
  assert.doesNotThrow(() => assertTenantCutoverReady({
    ENABLE_MULTI_TENANT: 'true',
    MULTI_TENANT_CUTOVER_APPROVED: 'true'
  }));
});

test('does not allow an approval flag without multi-tenant mode', () => {
  assert.throws(
    () => assertTenantCutoverReady({ MULTI_TENANT_CUTOVER_APPROVED: 'true' }),
    /cannot be set while ENABLE_MULTI_TENANT is false/
  );
});

test('server executes the fail-closed guard before opening the listener', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(source, /assertTenantCutoverReady\(process\.env\)/);
  assert.ok(source.indexOf('assertTenantCutoverReady(process.env)') < source.indexOf('app.listen('));
});

test('npm startup checks the tenant cutover flag before running migrations', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.prestart, 'node scripts/check-tenant-cutover.js');
  assert.equal(pkg.scripts.start, 'node migrate.js && node server.js');
});
