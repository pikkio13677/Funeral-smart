'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const getAllowedOrigins = require('../cors-origins');

const STAGING_ORIGIN = 'https://funeral-smart-web-staging.onrender.com';

test('staging allows only explicitly configured staging origins', () => {
  const origins = getAllowedOrigins({
    STAGING_MODE: 'true',
    CORS_ORIGIN: STAGING_ORIGIN
  });
  assert.deepEqual(origins, [STAGING_ORIGIN]);
  for (const productionOrigin of getAllowedOrigins.PRODUCTION_ORIGINS) {
    assert.equal(origins.includes(productionOrigin), false);
  }
});

test('staging fails closed if a production origin is configured accidentally', () => {
  assert.throws(() => getAllowedOrigins({
    STAGING_MODE: 'true',
    CORS_ORIGIN: STAGING_ORIGIN + ',https://funeralsmartapp.com'
  }), /Staging CORS cannot allow production origins/);
});

test('staging with no configured browser origin allows no browser origins', () => {
  assert.deepEqual(getAllowedOrigins({ STAGING_MODE: 'true' }), []);
});

test('production retains its established origins and adds configured origins', () => {
  const origins = getAllowedOrigins({
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://custom.example.com, https://funeral-smart-web.onrender.com'
  });
  for (const productionOrigin of getAllowedOrigins.PRODUCTION_ORIGINS) {
    assert.ok(origins.includes(productionOrigin));
  }
  assert.ok(origins.includes('https://custom.example.com'));
  assert.equal(origins.filter(origin => origin === 'https://funeral-smart-web.onrender.com').length, 1);
});

test('production origin defaults are not accidentally mutated', () => {
  const first = getAllowedOrigins({ STAGING_MODE: 'true', CORS_ORIGIN: STAGING_ORIGIN });
  first.push('https://attacker.example');
  assert.equal(getAllowedOrigins.PRODUCTION_ORIGINS.includes('https://attacker.example'), false);
});


test('server uses the dedicated environment-aware CORS allowlist', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/cors-origins'\)/);
  assert.match(server, /getAllowedOrigins\(process\.env\)/);
  assert.doesNotMatch(server, /const allowedOrigins = \[\.\.\.new Set\(\[/);
});
