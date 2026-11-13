'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createAuth = require('../auth');

function response() {
  return {
    statusCode: 200, body: null, cookies: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value) { this.cookies.push({ name, value }); }
  };
}
function postHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, 'missing POST ' + path);
  return layer.route.stack.at(-1).handle;
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('invitation registration is unavailable until tenant mode is enabled', async () => {
  const previous = process.env.ENABLE_MULTI_TENANT;
  delete process.env.ENABLE_MULTI_TENANT;
  let connected = false;
  try {
    const router = createAuth({ query: async () => ({}), connect: async () => { connected = true; } }).router;
    const res = response();
    await postHandler(router, '/invitation/register')({ body: { token: 'x'.repeat(48), username: 'mario', displayName: 'Mario Rossi', password: 'password-lunga-123' } }, res, error => { throw error; });
    assert.equal(res.statusCode, 404);
    assert.equal(connected, false);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_MULTI_TENANT;
    else process.env.ENABLE_MULTI_TENANT = previous;
  }
});

test('invitation registration creates an unverified operator identity and a session', async () => {
  const previous = process.env.ENABLE_MULTI_TENANT;
  process.env.ENABLE_MULTI_TENANT = 'true';
  const rawToken = 'invite-token-' + 'x'.repeat(40);
  const email = 'collega@example.com';
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations')) return { rowCount: 1, rows: [{ id: 'invite-1', email, status: 'pending', expiresAt: new Date(Date.now() + 60000) }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT id FROM app_users')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO app_users')) return { rowCount: 1, rows: [{ id: 'user-1', username: 'mario', displayName: 'Mario Rossi', role: 'operator', email }] };
      if (sql.includes('INSERT INTO app_sessions')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  try {
    const router = createAuth({ query: async () => ({}), connect: async () => client }).router;
    const res = response();
    await postHandler(router, '/invitation/register')({
      body: { token: rawToken, username: 'Mario', displayName: 'Mario Rossi', password: 'password-lunga-123' }
    }, res, error => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.email, email);
    assert.equal(res.body.data.role, 'operator');
    assert.equal(res.body.data.mfaEnabled, false);
    assert.equal(res.cookies[0].name, 'fs_session');
    const lookup = calls.find(call => call.sql.includes('FROM company_invitations'));
    assert.equal(lookup.args[0], digest(rawToken));
    const insert = calls.find(call => call.sql.includes('INSERT INTO app_users'));
    assert.equal(insert.args[0], 'mario');
    assert.equal(insert.args[3], 'operator');
    assert.equal(insert.args[4], email);
    assert.match(insert.args[2], /^scrypt\$/);
    assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock')));
    assert.ok(calls.some(call => call.sql === 'COMMIT'));
  } finally {
    if (previous === undefined) delete process.env.ENABLE_MULTI_TENANT;
    else process.env.ENABLE_MULTI_TENANT = previous;
  }
});

test('invitation registration rejects expired invitations without creating accounts', async () => {
  const previous = process.env.ENABLE_MULTI_TENANT;
  process.env.ENABLE_MULTI_TENANT = 'true';
  let inserted = false;
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations')) return { rowCount: 1, rows: [{ id: 'invite-expired', email: 'late@example.com', status: 'pending', expiresAt: new Date(Date.now() - 1000) }] };
      if (sql.includes('UPDATE company_invitations')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO app_users')) inserted = true;
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  try {
    const router = createAuth({ query: async () => ({}), connect: async () => client }).router;
    const res = response();
    await postHandler(router, '/invitation/register')({ body: { token: 'y'.repeat(48), username: 'lateuser', displayName: 'Late User', password: 'password-lunga-123' } }, res, error => { throw error; });
    assert.equal(res.statusCode, 410);
    assert.equal(inserted, false);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_MULTI_TENANT;
    else process.env.ENABLE_MULTI_TENANT = previous;
  }
});
