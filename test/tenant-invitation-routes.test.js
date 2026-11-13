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


test('acceptance hashes the raw token and creates membership only in the invitation company', async () => {
  const rawToken = 't'.repeat(48);
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations')) return { rowCount: 1, rows: [{ id: 'invite-1', companyId: 'company-from-db', email: 'member@example.com', role: 'operator', status: 'pending', expiresAt: new Date(Date.now() + 60000) }] };
      if (sql.includes('FROM app_users')) return { rowCount: 1, rows: [{ id: 'user-1', username: 'member', email: 'member@example.com', emailVerifiedAt: new Date(), active: true }] };
      if (sql.includes('FROM companies')) return { rowCount: 1, rows: [{ id: 'company-from-db' }] };
      if (sql.includes('FROM company_memberships')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO company_memberships')) return { rowCount: 1, rows: [{ id: 'membership-new' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const router = createRouter({ pool: { query: async () => ({ rowCount: 1, rows: [] }), connect: async () => client } });
  const res = response();
  await routeHandler(router, '/company/invitations/accept', 'post')({ user: { id: 'user-1' }, body: { token: rawToken } }, res, e => { throw e; });
  assert.equal(res.statusCode, 201);
  const invitationLookup = calls.find(c => c.sql.includes('FROM company_invitations'));
  assert.equal(invitationLookup.args[0].length, 64);
  assert.notEqual(invitationLookup.args[0], rawToken);
  const membershipInsert = calls.find(c => c.sql.includes('INSERT INTO company_memberships'));
  assert.deepEqual(membershipInsert.args, ['company-from-db', 'user-1', 'operator']);
  assert.ok(calls.some(c => c.sql === 'COMMIT'));
});

test('acceptance rejects unverified or mismatched email identities before creating membership', async () => {
  for (const identity of [
    { email: 'member@example.com', emailVerifiedAt: null },
    { email: 'other@example.com', emailVerifiedAt: new Date() }
  ]) {
    const calls = [];
    const client = {
      async query(sql, args = []) {
        calls.push({ sql, args });
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (sql.includes('FROM company_invitations')) return { rowCount: 1, rows: [{
          id: 'invite-2', companyId: 'company-from-db', email: 'member@example.com',
          role: 'operator', status: 'pending', expiresAt: new Date(Date.now() + 60000)
        }] };
        if (sql.includes('FROM app_users')) return { rowCount: 1, rows: [{
          id: 'user-1', username: 'member', ...identity, active: true
        }] };
        throw new Error('No later query should run for an unverified/mismatched identity: ' + sql);
      },
      release() {}
    };
    const router = createRouter({ pool: {
      query: async () => ({ rowCount: 0, rows: [] }),
      connect: async () => client
    } });
    const res = response();
    await routeHandler(router, '/company/invitations/accept', 'post')(
      { user: { id: 'user-1' }, body: { token: 't'.repeat(48) } },
      res,
      error => { throw error; }
    );
    assert.equal(res.statusCode, 403);
    assert.equal(calls.some(c => c.sql.includes('INSERT INTO company_memberships')), false);
    assert.equal(calls.some(c => c.sql.includes('UPDATE app_users SET email')), false);
    assert.ok(calls.some(c => c.sql === 'ROLLBACK'));
  }
});

test('invitation listing is always scoped to the verified tenant company', async () => {
  let call;
  const router = createRouter({ pool: {
    query: async (sql, args) => { call = { sql, args }; return { rowCount: 0, rows: [] }; },
    connect: async () => ({})
  } });
  const res = response();
  await routeHandler(router, '/company/invitations', 'get')({ tenant, query: {} }, res, e => { throw e; });
  assert.match(call.sql, /WHERE company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
  assert.equal(res.statusCode, 200);
});
