'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-invitation-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function routeHandler(router, path, method) {
  const layer = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  assert.ok(layer, 'missing route ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };

test('invitation creation is disabled when no email provider is configured', async () => {
  let connected = false;
  const router = createRouter({ pool: { query: async () => ({}), connect: async () => { connected = true; } } });
  const res = response();
  await routeHandler(router, '/company/invitations', 'post')({ tenant, body: { email: 'user@example.com', role: 'operator' } }, res, e => { throw e; });
  assert.equal(res.statusCode, 503);
  assert.equal(connected, false);
});

test('invitation creation requires verified tenant context', () => {
  const router = createRouter({ pool: { query: async () => ({}), connect: async () => ({}) } });
  const guard = router.stack.find(x => x.name === '<anonymous>');
  assert.ok(guard);
  const res = response();
  let nextCalled = false;
  guard.handle({ tenant: null }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('acceptance requires an authenticated account and rejects malformed token before database access', async () => {
  let connected = false;
  const router = createRouter({ pool: { query: async () => ({}), connect: async () => { connected = true; } } });
  const handler = routeHandler(router, '/company/invitations/accept', 'post');
  const unauth = response();
  await handler({ user: null, body: { token: 'x'.repeat(40) } }, unauth, e => { throw e; });
  assert.equal(unauth.statusCode, 401);
  const invalid = response();
  await handler({ user: { id: 'user-1' }, body: { token: 'short' } }, invalid, e => { throw e; });
  assert.equal(invalid.statusCode, 400);
  assert.equal(connected, false);
});

test('invitation role schema never accepts platform administrator', async () => {
  let connected = false;
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => { connected = true; } },
    sendInvitationEmail: async () => {},
    publicAppUrl: 'https://funeral-smart.example'
  });
  const res = response();
  await routeHandler(router, '/company/invitations', 'post')({ tenant, body: { email: 'user@example.com', role: 'platform_admin' } }, res, e => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});
