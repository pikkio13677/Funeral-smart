'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mountApiRouters = require('../api-route-mounts');

function fixtures(enabled, approved = enabled, options = {}) {
  const mounts = [];
  const app = { use(path, ...handlers) { mounts.push({ path, handlers }); } };
  const pool = {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() { throw new Error('No connection expected while mounting routers.'); }
  };
  const auth = {
    router: express.Router(),
    authenticate(_req, _res, next) { next(); },
    authorize(_req, _res, next) { next(); }
  };
  const rateLimit = () => (_req, _res, next) => next();
  const emailNotifications = { async notifyCompanyInvitation() { return true; } };
  const result = mountApiRouters({
    app, pool, auth, emailNotifications, rateLimit,
    env: {
      ENABLE_MULTI_TENANT: enabled ? 'true' : 'false',
      MULTI_TENANT_CUTOVER_APPROVED: approved ? 'true' : 'false',
      PUBLIC_APP_URL: 'https://example.invalid',
      ENABLE_PROVIDER_PORTAL_INVITATIONS: options.providerInvitations ? 'true' : 'false'
    }
  });
  return { mounts, result };
}

test('legacy mode mounts only the existing authentication router', () => {
  const { mounts, result } = fixtures(false);
  assert.equal(result.multiTenantEnabled, false);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].path, '/api/v1/auth');
  assert.equal(mounts.some(item => item.path === '/api/v1/platform'), false);
});

test('tenant mode mounts company, tenant and platform APIs on separate prefixes', () => {
  const { mounts, result } = fixtures(true);
  assert.equal(result.multiTenantEnabled, true);
  assert.equal(mounts.filter(item => item.path === '/api/v1/auth').length, 3);
  assert.equal(mounts.filter(item => item.path === '/api/v1/admin').length, 1);
  assert.equal(mounts.filter(item => item.path === '/api/v1/platform').length, 2);
  assert.equal(mounts.find(item => item.path === '/api/v1/admin').handlers[0], result.tenantApi.router);
  assert.equal(result.tenantApi.router.stack[0].handle.name, 'authenticate');
  assert.ok(result.marketplaceRouter);
  assert.ok(mounts.some(item => item.path === '/api/v1/platform' && item.handlers[0] === result.marketplaceRouter));
});

test('tenant mode refuses to mount without explicit cutover approval', () => {
  assert.throws(
    () => fixtures(true, false),
    /MULTI_TENANT_CUTOVER_APPROVED/
  );
});

test('tenant mode blocks legacy global user administration before auth routes', () => {
  const { result } = fixtures(true);
  const guard = result.authRouter.stack[0].handle;
  let statusCode;
  let payload;
  guard({ path: '/users' }, {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  }, () => assert.fail('global user route should be blocked'));
  assert.equal(statusCode, 404);
  assert.match(payload.error, /gestione globale degli utenti/);
});

test('tenant mode leaves ordinary authentication endpoints reachable', () => {
  const { result } = fixtures(true);
  const guard = result.authRouter.stack[0].handle;
  let continued = false;
  guard({ path: '/login' }, {}, () => { continued = true; });
  assert.equal(continued, true);
});


test('tenant mode blocks URL-encoded global user administration paths', () => {
  const { result } = fixtures(true);
  const guard = result.authRouter.stack[0].handle;
  let statusCode;
  guard({ path: '/us%65rs' }, {
    status(code) { statusCode = code; return this; },
    json() { return this; }
  }, () => assert.fail('encoded global user route should be blocked'));
  assert.equal(statusCode, 404);
});


test('provider invitation API is not mounted unless its dedicated feature flag is true', () => {
  const disabled = fixtures(false);
  assert.equal(disabled.result.providerInvitationsEnabled, false);
  assert.equal(disabled.mounts.some(item => item.path === '/api/v1/provider-portal'), false);

  const enabled = fixtures(false, false, { providerInvitations: true });
  assert.equal(enabled.result.providerInvitationsEnabled, true);
  const mount = enabled.mounts.find(item => item.path === '/api/v1/provider-portal');
  assert.ok(mount);
  assert.equal(mount.handlers.at(-1), enabled.result.providerInvitationRouter);
  assert.equal(enabled.result.multiTenantEnabled, false);
});

test('provider invitation API is not implicitly enabled by multi-tenant mode', () => {
  const { result, mounts } = fixtures(true);
  assert.equal(result.providerInvitationsEnabled, false);
  assert.equal(mounts.some(item => item.path === '/api/v1/provider-portal'), false);
});
