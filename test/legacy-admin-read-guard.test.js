'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createGuard = require('../legacy-admin-read-guard');

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

test('legacy global admin reads are blocked when multi-tenant mode is enabled', () => {
  const guard = createGuard(true);
  const res = response();
  let continued = false;
  guard({}, res, () => { continued = true; });
  assert.equal(res.statusCode, 410);
  assert.equal(continued, false);
  assert.match(res.body.error, /Consultazione globale disabilitata/);
});

test('legacy global admin reads continue only while multi-tenant mode is disabled', () => {
  const guard = createGuard(false);
  const res = response();
  let continued = false;
  guard({}, res, () => { continued = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(continued, true);
});

test('server applies the guard after authentication and authorization to both global read endpoints', () => {
  const server = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/v1\/admin\/inquiries', auth\.authenticate, auth\.authorize, legacyAdminReadGuard,/);
  assert.match(server, /app\.get\('\/api\/v1\/admin\/provider-applications', auth\.authenticate, auth\.authorize, legacyAdminReadGuard,/);
});


test('all legacy admin department routes are disabled in tenant mode, not only two GET endpoints', () => {
  const server = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /if \(tenantFeaturesEnabled\) \{\s*app\.use\('\/api\/v1\/admin', \(_req, res\) => res\.status\(410\)/);
  assert.match(server, /else \{\s*app\.use\('\/api\/v1\/admin', auth\.authenticate, auth\.authorize, require\('\.\/admin-routes'\)/);
  assert.doesNotMatch(server, /app\.use\('\/api\/v1\/admin', auth\.authenticate, auth\.authorize, require\('\.\/admin-routes'\)[\s\S]*?if \(tenantFeaturesEnabled\)/);
});
