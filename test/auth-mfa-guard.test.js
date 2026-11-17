'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createAuth = require('../auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function authPool(user) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('FROM app_sessions s JOIN app_users u')) {
        return { rowCount: 1, rows: [{ active: true, ...user }] };
      }
      if (sql.includes('UPDATE app_sessions SET last_seen_at')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected auth query: ' + sql);
    }
  };
}

test('blocks a global administrator without MFA from protected routes', async () => {
  const pool = authPool({ id: 'admin-1', username: 'admin', role: 'admin', mfaEnabled: false });
  const auth = createAuth(pool);
  const res = response();
  let continued = false;
  await auth.authenticate({
    cookies: { fs_session: 'session-token-value-1234567890123456' },
    path: '/sensitive',
    method: 'GET'
  }, res, () => { continued = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
  assert.match(res.body.error, /verifica in due passaggi/);
  assert.equal(pool.calls.some(call => call.sql.includes('UPDATE app_sessions SET last_seen_at')), false);
});

test('allows a global administrator with MFA on protected routes', async () => {
  const pool = authPool({ id: 'admin-2', username: 'admin2', role: 'admin', mfaEnabled: true });
  const auth = createAuth(pool);
  const res = response();
  let continued = false;
  await auth.authenticate({
    cookies: { fs_session: 'session-token-value-1234567890123456' },
    path: '/sensitive',
    method: 'GET'
  }, res, () => { continued = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(continued, true);
  assert.ok(pool.calls.some(call => call.sql.includes('UPDATE app_sessions SET last_seen_at')));
});

test('does not impose the legacy global-admin MFA gate on ordinary tenant roles', async () => {
  const pool = authPool({ id: 'operator-1', username: 'operator', role: 'operator', mfaEnabled: false });
  const auth = createAuth(pool);
  const res = response();
  let continued = false;
  await auth.authenticate({
    cookies: { fs_session: 'session-token-value-1234567890123456' },
    path: '/sensitive',
    method: 'GET'
  }, res, () => { continued = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(continued, true);
});

test('allows only the documented MFA setup and account recovery paths before MFA is enabled', async () => {
  for (const path of ['/mfa/setup', '/mfa/enable', '/me', '/logout']) {
    const pool = authPool({ id: 'admin-3', username: 'admin3', role: 'admin', mfaEnabled: false });
    const auth = createAuth(pool);
    const res = response();
    let continued = false;
    await auth.authenticate({
      cookies: { fs_session: 'session-token-value-1234567890123456' },
      path,
      method: 'GET'
    }, res, () => { continued = true; });
    assert.equal(res.statusCode, 200, path + ' should remain available for MFA setup/recovery');
    assert.equal(continued, true, path + ' should pass authentication');
  }
});


test('requires MFA for the separate platform-owner identity', async () => {
  const pool = authPool({ id: 'owner-1', username: 'owner', role: 'platform_owner', mfaEnabled: false });
  const auth = createAuth(pool);
  const res = response();
  let continued = false;
  await auth.authenticate({
    cookies: { fs_session: 'session-token-value-1234567890123456' },
    path: '/platform',
    method: 'GET'
  }, res, () => { continued = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

test('platform owner cannot use legacy company-admin authorization', async () => {
  const auth = createAuth({ query: async () => ({ rowCount: 0, rows: [] }) });
  const res = response();
  let continued = false;
  auth.authorize(
    { user: { id: 'owner-2', role: 'platform_owner' }, method: 'GET', path: '/dashboard' },
    res,
    () => { continued = true; }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

test('platform owner can reach only the documented MFA setup paths before MFA is enabled', async () => {
  const pool = authPool({ id: 'owner-3', username: 'owner3', role: 'platform_owner', mfaEnabled: false });
  const auth = createAuth(pool);
  const res = response();
  let continued = false;
  await auth.authenticate({
    cookies: { fs_session: 'session-token-value-1234567890123456' },
    path: '/mfa/setup',
    method: 'POST'
  }, res, () => { continued = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(continued, true);
});
