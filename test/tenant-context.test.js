'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createTenantContext = require('../tenant-context');

const hashToken = token => 'hash:' + token;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('rejects requests without an authenticated identity', async () => {
  const middleware = createTenantContext({ query: async () => { throw new Error('must not query'); } }, hashToken);
  const res = response();
  let nextCalled = false;
  await middleware({ cookies: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('rejects requests without a session cookie', async () => {
  const middleware = createTenantContext({ query: async () => { throw new Error('must not query'); } }, hashToken);
  const res = response();
  await middleware({ user: { id: 'user-1' }, cookies: {} }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('denies users without a current active company membership', async () => {
  let queryArgs;
  const middleware = createTenantContext({
    query: async (sql, args) => {
      assert.match(sql, /m\.status = 'active'/);
      assert.match(sql, /c\.status = 'active'/);
      queryArgs = args;
      return { rowCount: 0, rows: [] };
    }
  }, hashToken);
  const req = { user: { id: 'user-1' }, cookies: { fs_session: 'a'.repeat(40) } };
  const res = response();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.deepEqual(queryArgs, ['hash:' + 'a'.repeat(40), 'user-1']);
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
  assert.equal(req.tenant, undefined);
});

test('sets tenant context only from the verified database membership', async () => {
  const middleware = createTenantContext({
    query: async (sql, args) => {
      assert.match(sql, /m\.user_id = s\.user_id/);
      assert.match(sql, /s\.active_membership_id/);
      assert.deepEqual(args, ['hash:' + 'b'.repeat(40), 'user-2']);
      return {
        rowCount: 1,
        rows: [{ membershipId: 'membership-7', companyId: 'company-9', role: 'warehouse' }]
      };
    }
  }, hashToken);

  const req = { user: { id: 'user-2', role: 'admin' }, cookies: { fs_session: 'b'.repeat(40) }, body: { companyId: 'attacker-company' } };
  const res = response();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.tenant, {
    membershipId: 'membership-7',
    companyId: 'company-9',
    role: 'warehouse'
  });
  assert.equal(Object.isFrozen(req.tenant), true);
  assert.notEqual(req.tenant.companyId, req.body.companyId);
});

test('forwards database errors to Express error handling', async () => {
  const expected = new Error('database unavailable');
  const middleware = createTenantContext({ query: async () => { throw expected; } }, hashToken);
  let received;
  await middleware(
    { user: { id: 'user-3' }, cookies: { fs_session: 'c'.repeat(40) } },
    response(),
    error => { received = error; }
  );
  assert.equal(received, expected);
});
