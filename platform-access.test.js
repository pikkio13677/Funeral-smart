'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createPlatformAccess = require('./platform-access');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('platform authorization rejects missing authenticated user', async () => {
  let queried = false;
  const middleware = createPlatformAccess({ query: async () => { queried = true; } })
    .requirePlatformRole('owner');
  const res = response();
  let nextCalled = false;

  await middleware({ user: null }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
  assert.equal(queried, false);
});

test('platform authorization does not treat legacy admin role as platform owner', async () => {
  const middleware = createPlatformAccess({ query: async () => ({ rowCount: 0, rows: [] }) })
    .requirePlatformRole('owner');
  const res = response();
  let nextCalled = false;

  await middleware({ user: { id: 'user-1', role: 'admin' } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('active platform owner is authorized from platform_access database row', async () => {
  let queryArgs;
  const middleware = createPlatformAccess({
    query: async (_sql, args) => {
      queryArgs = args;
      return { rowCount: 1, rows: [{ role: 'owner', mfaEnabled: true }] };
    }
  }).requirePlatformRole('owner');
  const req = { user: { id: 'user-1', role: 'operator' } };
  const res = response();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.deepEqual(queryArgs, ['user-1', ['owner']]);
  assert.deepEqual(req.platformAccess, { role: 'owner' });
});

test('support role cannot enter an owner-only route', async () => {
  const middleware = createPlatformAccess({
    query: async () => ({ rowCount: 0, rows: [] })
  }).requirePlatformRole('owner');
  const res = response();
  let nextCalled = false;

  await middleware({ user: { id: 'user-2', role: 'admin' } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});


test('active platform support without MFA is rejected', async () => {
  const middleware = createPlatformAccess({
    query: async () => ({ rowCount: 1, rows: [{ role: 'support', mfaEnabled: false }] })
  }).requirePlatformRole('support');
  const res = response();
  let nextCalled = false;

  await middleware({ user: { id: 'user-3', role: 'operator' } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /verifica in due passaggi/);
  assert.equal(nextCalled, false);
});
