'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-audit-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function handler(router) {
  const layer = router.stack.find(x => x.route?.path === '/company/activity' && x.route.methods.get);
  assert.ok(layer, 'missing GET /company/activity');
  return layer.route.stack.at(-1).handle;
}
const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };

test('activity query is strictly scoped to verified company and omits IP address', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [{ id: '9', username: 'mario', action: 'case.created', createdAt: '2026-11-12T10:00:00.000Z' }] }; } });
  const res = response();
  await handler(router)({ tenant, query: { limit: '20' } }, res, e => { throw e; });
  assert.match(call.sql, /WHERE a\.company_id = \$1/);
  assert.match(call.sql, /ORDER BY a\.created_at DESC, a\.id DESC/);
  assert.deepEqual(call.args, ['company-alpha', 21]);
  assert.doesNotMatch(call.sql, /ip_address/);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
});

test('activity pagination cursor is validated and bound, not interpolated', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [] }; } });
  const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-11-12T10:00:00.000Z', id: '42' })).toString('base64url');
  const res = response();
  await handler(router)({ tenant, query: { limit: '10', cursor } }, res, e => { throw e; });
  assert.match(call.sql, /\(a\.created_at, a\.id\) < \(\$2::timestamptz, \$3::bigint\)/);
  assert.deepEqual(call.args, ['company-alpha', '2026-11-12T10:00:00.000Z', '42', 11]);
});

test('invalid cursor is rejected before database access', async () => {
  let queried = false;
  const router = createRouter({ query: async () => { queried = true; return { rows: [] }; } });
  const res = response();
  await handler(router)({ tenant, query: { cursor: 'not-a-cursor' } }, res, e => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.equal(queried, false);
});

test('tenant activity route rejects missing tenant context', async () => {
  const router = createRouter({ query: async () => ({ rows: [] }) });
  const layer = router.stack[0];
  assert.ok(layer);
  const res = response();
  let nextCalled = false;
  layer.handle({ tenant: null }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});
