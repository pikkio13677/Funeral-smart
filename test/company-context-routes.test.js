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

test('uses the configured session cookie name when selecting a company', async () => {
  let receivedArgs;
  const client = {
    async query(sql, args) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: null, rows: [] };
      if (/SELECT id/.test(sql)) { receivedArgs = args; return { rowCount: 1, rows: [{ id: 'session-custom' }] }; }
      if (/SELECT m\\.id/.test(sql)) return { rowCount: 1, rows: [{ membershipId: 'member-custom', companyId: '44444444-4444-4444-8444-444444444444', role: 'admin', legalName: 'Impresa Custom' }] };
      if (/UPDATE app_sessions/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    release() {}
  };
  const router = createCompanyContextRouter(
    { connect: async () => client },
    (_req, _res, next) => next(),
    token => 'custom-hash:' + token,
    'custom_session'
  );
  const res = response();
  await routeHandler(router, '/active-company', 'post')({
    user: { id: 'user-custom' },
    cookies: { custom_session: 'z'.repeat(40) },
    body: { companyId: '44444444-4444-4444-8444-444444444444' }
  }, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(receivedArgs, ['custom-hash:' + 'z'.repeat(40), 'user-custom']);
});

test('rejects an invalid configured cookie name', () => {
  assert.throws(() => createCompanyContextRouter(
    { connect: async () => ({}) },
    (_req, _res, next) => next(),
    token => token,
    'bad cookie name'
  ), TypeError);
});


test('initial company bootstrap requires a verified admin session and explicit legacy ownership confirmation', async () => {
  let connected = false;
  const router = createCompanyContextRouter({
    connect: async () => { connected = true; return {}; }
  }, (_req, _res, next) => next(), token => token);
  const handler = routeHandler(router, '/companies/bootstrap', 'post');
  const forbidden = response();
  await handler({
    user: { id: 'user-1', role: 'operator' },
    cookies: { fs_session: 's'.repeat(40) },
    body: { legalName: 'Impresa Alfa', confirmLegacyDataOwnership: true }
  }, forbidden, () => {});
  assert.equal(forbidden.statusCode, 403);

  const noMfa = response();
  await handler({
    user: { id: 'user-1', role: 'admin', mfaEnabled: false },
    cookies: { fs_session: 's'.repeat(40) },
    body: { legalName: 'Impresa Alfa', confirmLegacyDataOwnership: true }
  }, noMfa, () => {});
  assert.equal(noMfa.statusCode, 403);
  assert.match(noMfa.body.error, /due passaggi/i);

  const missingConfirmation = response();
  await handler({
    user: { id: 'user-1', role: 'admin', mfaEnabled: true },
    cookies: { fs_session: 's'.repeat(40) },
    body: { legalName: 'Impresa Alfa' }
  }, missingConfirmation, () => {});
  assert.equal(missingConfirmation.statusCode, 400);
  assert.equal(connected, false);
});

test('initial company bootstrap creates first membership, backfills legacy rows, and activates the current session atomically', async () => {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM app_sessions')) return { rowCount: 1, rows: [{ id: 'session-1' }] };
      if (sql.startsWith('LOCK TABLE')) return { rowCount: null, rows: [] };
      if (sql === 'SELECT id FROM companies LIMIT 1') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO companies')) return { rowCount: 1, rows: [{
        id: 'company-1', legalName: 'Impresa Alfa', city: 'Torino', province: 'TO'
      }] };
      if (sql.includes('INSERT INTO company_memberships')) return { rowCount: 1, rows: [{ id: 'membership-1' }] };
      if (sql.startsWith('UPDATE ') && sql.includes('SET company_id = $1 WHERE company_id IS NULL')) return { rowCount: 2, rows: [] };
      if (sql.includes('UPDATE app_sessions SET active_membership_id')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() { calls.push({ released: true }); }
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => 'digest:' + token);
  const res = response();
  await routeHandler(router, '/companies/bootstrap', 'post')({
    user: { id: 'user-1', username: 'admin', role: 'admin', mfaEnabled: true },
    cookies: { fs_session: 's'.repeat(40) },
    body: {
      legalName: 'Impresa Alfa', city: 'Torino', province: 'TO',
      confirmLegacyDataOwnership: true
    }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.id, 'company-1');
  assert.equal(res.body.data.membershipId, 'membership-1');
  assert.equal(res.body.data.role, 'admin');
  assert.equal(Object.keys(res.body.backfilled).length, 9);
  assert.ok(calls.some(call => call.sql.startsWith('LOCK TABLE')));
  assert.ok(calls.some(call => call.sql.includes('UPDATE customers SET company_id')));
  assert.ok(calls.some(call => call.sql.includes('UPDATE payments SET company_id')));
  assert.ok(calls.some(call => call.sql.includes('UPDATE app_sessions SET active_membership_id')));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO audit_log')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.ok(calls.some(call => call.released));
});

test('initial company bootstrap refuses to overwrite an existing tenant and rolls back', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM app_sessions')) return { rowCount: 1, rows: [{ id: 'session-1' }] };
      if (sql.startsWith('LOCK TABLE')) return { rowCount: 0, rows: [] };
      if (sql === 'SELECT id FROM companies LIMIT 1') return { rowCount: 1, rows: [{ id: 'existing-company' }] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => token);
  const res = response();
  await routeHandler(router, '/companies/bootstrap', 'post')({
    user: { id: 'user-1', role: 'admin', mfaEnabled: true },
    cookies: { fs_session: 's'.repeat(40) },
    body: { legalName: 'Impresa Beta', confirmLegacyDataOwnership: true }
  }, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.some(sql => sql.includes('INSERT INTO companies')));
});


test('additional company creation requires MFA before database access', async () => {
  let connected = false;
  const router = createCompanyContextRouter({
    connect: async () => { connected = true; return {}; }
  }, (_req, _res, next) => next(), token => token);
  const res = response();
  await routeHandler(router, '/companies', 'post')({
    user: { id: 'user-1', mfaEnabled: false },
    cookies: { fs_session: 'm'.repeat(40) },
    body: { legalName: 'Impresa Nuova' }
  }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(connected, false);
});

test('additional company creation requires an active admin membership in the current session', async () => {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT s.id AS "sessionId"')) return { rowCount: 1, rows: [{ sessionId: 'session-1', role: 'manager', membershipId: 'membership-1' }] };
      throw new Error('Unexpected query: ' + sql);
    },
    release() {}
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => 'hash:' + token);
  const res = response();
  await routeHandler(router, '/companies', 'post')({
    user: { id: 'user-1', mfaEnabled: true },
    cookies: { fs_session: 'n'.repeat(40) },
    body: { legalName: 'Impresa Nuova' }
  }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO companies')));
});

test('additional company creation creates an isolated company and admin membership without backfilling old records', async () => {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT s.id AS "sessionId"')) return { rowCount: 1, rows: [{ sessionId: 'session-1', role: 'admin', membershipId: 'membership-old' }] };
      if (sql.includes('INSERT INTO companies')) return { rowCount: 1, rows: [{ id: 'company-new', legalName: 'Impresa Nuova', city: 'Torino', province: 'TO' }] };
      if (sql.includes('INSERT INTO company_memberships')) return { rowCount: 1, rows: [{ id: 'membership-new' }] };
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    release() { calls.push({ released: true }); }
  };
  const router = createCompanyContextRouter({ connect: async () => client }, (_req, _res, next) => next(), token => 'hash:' + token);
  const res = response();
  await routeHandler(router, '/companies', 'post')({
    user: { id: 'user-1', username: 'owner', mfaEnabled: true },
    cookies: { fs_session: 'p'.repeat(40) },
    body: { legalName: 'Impresa Nuova', city: 'Torino', province: 'TO' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.id, 'company-new');
  assert.equal(res.body.data.role, 'admin');
  assert.equal(res.body.data.membershipId, 'membership-new');
  assert.match(calls.find(call => call.sql.includes('SELECT s.id AS "sessionId"')).sql, /m.role/);
  assert.deepEqual(calls.find(call => call.sql.includes('INSERT INTO company_memberships')).args, ['company-new', 'user-1']);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO audit_log')));
  assert.ok(!calls.some(call => /UPDATE (customers|funeral_cases|staff|vehicles|inventory_items|tasks|invoices|payments)/.test(call.sql)));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.ok(calls.some(call => call.released));
});
