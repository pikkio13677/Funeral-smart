'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createAuth = require('../auth');

test('auth exports the exact SHA-256 token hash used by session middleware', () => {
  const auth = createAuth({ query: async () => ({ rowCount: 0, rows: [] }) });
  const token = 'tenant-session-token-unit-test';
  const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  assert.equal(typeof auth.tokenHash, 'function');
  assert.equal(auth.tokenHash(token), expected);
});

test('tenant mode disables the complete legacy admin router', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(
    server,
    /if \(tenantFeaturesEnabled\) \{[\s\S]*?app\.use\('\/api\/v1\/admin', \(_req, res\) => res\.status\(410\)/
  );
  assert.match(
    server,
    /\} else \{\s*app\.use\('\/api\/v1\/admin', auth\.authenticate, auth\.authorize, require\('\.\/admin-routes'\)/
  );
});
