'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createAuth = require('../auth');

test('auth exports the same token hash used by its session middleware', () => {
  const auth = createAuth({ query: async () => ({ rowCount: 0, rows: [] }) });
  const token = 'session-token-for-unit-test';
  const expected = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(typeof auth.tokenHash, 'function');
  assert.equal(auth.tokenHash(token), expected);
});
