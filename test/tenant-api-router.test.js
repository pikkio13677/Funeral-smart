'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createTenantApi = require('../tenant-api-router');

function fakePool() {
  return {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() { throw new Error('No database connection expected during router construction.'); }
  };
}

test('tenant API requires a real authentication middleware and PostgreSQL pool', () => {
  assert.throws(() => createTenantApi({ pool: fakePool() }), /authentication middleware/i);
  assert.throws(() => createTenantApi({ authenticate: (_req, _res, next) => next() }), /PostgreSQL pool/i);
});

test('company selection routes are exposed separately from tenant-protected data routes', () => {
  const authenticate = (_req, _res, next) => next();
  const api = createTenantApi({ pool: fakePool(), authenticate });
  const paths = api.companyContextRouter.stack
    .filter(layer => layer.route)
    .map(layer => layer.route.path);
  assert.deepEqual(paths, ['/companies', '/active-company']);
  assert.equal(api.router.stack[0].handle, authenticate);
});

test('invitation acceptance is mounted before tenant context, all company data routes after it', () => {
  const authenticate = (_req, _res, next) => next();
  const api = createTenantApi({ pool: fakePool(), authenticate });
  const layers = api.router.stack;
  assert.equal(layers[0].handle, authenticate);

  const acceptanceLayer = layers[1];
  assert.ok(acceptanceLayer.handle.stack.some(layer =>
    layer.route?.path === '/company/invitations/accept' && layer.route.methods.post
  ), 'authenticated invitation acceptance must be reachable before a tenant is selected');

  const tenantContextLayer = layers[2];
  assert.equal(tenantContextLayer.handle.name, 'tenantContext');

  const mountedRouters = layers.slice(3).filter(layer => Array.isArray(layer.handle.stack));
  const expectedRoutes = [
    '/dashboard', '/customers', '/cases', '/staff', '/vehicles',
    '/inventory', '/tasks', '/invoices', '/company/profile',
    '/company/activity', '/company/invitations'
  ];
  const registeredPaths = mountedRouters.flatMap(layer =>
    layer.handle.stack.filter(child => child.route).map(child => child.route.path)
  );
  for (const route of expectedRoutes) {
    assert.ok(registeredPaths.includes(route), 'missing tenant route ' + route);
  }
});

test('company selection uses the same SHA-256 session token digest as tenant context', () => {
  assert.equal(
    createTenantApi.hashSessionToken('example-session-token'),
    require('node:crypto').createHash('sha256').update('example-session-token').digest('hex')
  );
});
