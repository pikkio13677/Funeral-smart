'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertTenantCutoverReady = require('../tenant-cutover-guard');

test('keeps the dormant tenant API disabled by default', () => {
  assert.doesNotThrow(() => assertTenantCutoverReady({ ENABLE_MULTI_TENANT: 'false' }));
  assert.doesNotThrow(() => assertTenantCutoverReady({}));
});

test('fails closed if multi-tenant mode is enabled before route cutover', () => {
  assert.throws(
    () => assertTenantCutoverReady({ ENABLE_MULTI_TENANT: 'true' }),
    /tenant API and legacy-route cutover are not mounted/
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
