'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createCompanyContextRouter = require('../company-context-routes');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function routeHandler(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, 'expected route ' + method.toUpperCase() + ' ' + path);
  return layer.route.stack[0].handle;
}

test('lists only active companies belonging to the authenticated user', async () => {
  let received;
  const router = createCompanyContextRouter({
    connect: async () => { throw new Error('connect must not be used'); },
    query: async (sql, args) => {
      assert.match(sql, /m\.status = 'active'/);
      assert.match(sql, /c\.status = 'active'/);
      received = args;
      return { rowCount: 1, rows: [{ id: 'company-1', legalName: 'Impresa Alfa', membershipId: 'member-1', role: 'admin' }] };
    }
  }, (_req, _res, next) => next(), token => 'hash:' + token);

  const req = { user: { id: 'user-1' } };
  const res = response();
  let nextError;
  await routeHandler(router, '/companies', 'get')(req, res, error => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.deepEqual(received, ['user-1']);
  assert.equal(res.body.data[0].legalName, 'Impresa Alfa');
});

test('rejects invalid company identifiers before opening a transaction', async () => {
  const router = createCompanyContextRouter({
    connect: async () => { throw new Error('must not connect'); },
    query: async () => ({ rowCount: 0, rows: [] })
  }, (_req, _res, next) => next(), token => token);
  const res = response();
  await routeHandler(router, '/active-company', 'post')({
    user: { id: 'user-1' }, cookies: { fs_session: 'x'.repeat(40) }, body: { companyId: 'not-a-uuid' }
  }, res, () => {});
  assert.equal(res.statusCode, 400);
});

test('selects only a membership verified for the current user and session', async () => {
  const calls = [];
  const client = {
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: null, rows: [] };
      if (/SELECT id/.test(sql)) return { rowCount: 1, rows: [{ id: 'session-1' }] };
      if (/SELECT m\.id/.test(sql)) return { rowCount: 1, rows: [{ membershipId: 'member-2', companyId: '22222222-2222-4222-8222-222222222222', role: 'warehouse', legalName: 'Impresa Beta' }] };
      if (/UPDATE app_sessions/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    release() { calls.push({ released: true }); }
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => 'hashed-' + token);
  const res = response();
  let nextError;
  await routeHandler(router, '/active-company', 'post')({
    user: { id: 'user-2' },
    cookies: { fs_session: 's'.repeat(40) },
    body: { companyId: '22222222-2222-4222-8222-222222222222' }
  }, res, error => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.role, 'warehouse');
  assert.deepEqual(calls[1].args, ['hashed-' + 's'.repeat(40), 'user-2']);
  assert.deepEqual(calls[2].args, ['user-2', '22222222-2222-4222-8222-222222222222']);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.ok(calls.some(call => call.released));
});

test('rolls back when the user is not a member of the requested company', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (/SELECT id/.test(sql)) return { rowCount: 1, rows: [{ id: 'session-1' }] };
      if (/SELECT m\.id/.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    release() {}
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => token);
  const res = response();
  await routeHandler(router, '/active-company', 'post')({
    user: { id: 'user-3' },
    cookies: { fs_session: 't'.repeat(40) },
    body: { companyId: '33333333-3333-4333-8333-333333333333' }
  }, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
});
