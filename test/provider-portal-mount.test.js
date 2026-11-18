'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mountApiRouters = require('../api-route-mounts');

async function withApp(configure, run) {
  const app = express();
  const server = http.createServer(app);
  configure(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function dependencies(pool, env) {
  const appAuth = express.Router();
  return {
    appAuth,
    mount(app) {
      return mountApiRouters({
        app, pool, env,
        auth: { router: appAuth, authenticate: (req, _res, next) => { req.user = { id: 'test-user', role: 'provider_admin' }; next(); } },
        emailNotifications: { notifyProviderUserInvitation: async () => true },
        rateLimit: () => (_req, _res, next) => next()
      });
    }
  };
}

test('provider portal API is not mounted unless its dedicated flag is explicitly true', async () => {
  const pool = { async query() { throw new Error('provider schema must not be queried while disabled'); } };
  await withApp(app => {
    const deps = dependencies(pool, { ENABLE_PROVIDER_PORTAL: 'false', ENABLE_MULTI_TENANT: 'false' });
    const mounted = deps.mount(app);
    assert.equal(mounted.providerPortal, null);
  }, async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me');
    assert.equal(response.status, 404);
  });
});

test('enabled provider portal fails closed with 503 until all draft schema tables exist', async () => {
  const pool = { async connect() { return { async query() { return { rowCount: 0, rows: [] }; }, release() {} }; }, async query() { return { rowCount: 1, rows: [{
    providers: true,
    provider_user_access: false,
    provider_user_invitations: false,
    provider_inquiry_responses: false,
    provider_portal_audit_log: false,
    inquiry_provider_assignments: true,
    inquiries: true
  }] }; } };
  await withApp(app => {
    const deps = dependencies(pool, { ENABLE_PROVIDER_PORTAL: 'true', ENABLE_MULTI_TENANT: 'false', PUBLIC_APP_URL: 'https://portal.example.test' });
    const mounted = deps.mount(app);
    assert.equal(mounted.providerPortal.enabled, true);
  }, async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /schema richiesto non disponibile/i);
  });
});

test('invitation router is mounted before provider membership middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api-route-mounts.js'), 'utf8');
  assert.ok(source.indexOf('createProviderPortalInvitationRouter({') < source.indexOf('createProviderPortalRouter(pool'));
});
