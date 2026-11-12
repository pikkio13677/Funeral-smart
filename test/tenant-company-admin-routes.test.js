'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-company-admin-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function handler(router, path, method) {
  const layer = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  assert.ok(layer, 'missing ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };
const memberId = '11111111-1111-4111-8111-111111111111';

test('company profile read is restricted to the active company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rowCount: 1, rows: [{ id: 'company-alpha' }] }; }, connect() {} });
  const res = response();
  await handler(router, '/company/profile', 'get')({ tenant }, res, e => { throw e; });
  assert.match(call.sql, /FROM companies WHERE id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
  assert.equal(res.statusCode, 200);
});

test('company profile update rejects browser-supplied company identity', async () => {
  let queried = false;
  const router = createRouter({ query: async () => { queried = true; return { rows: [] }; }, connect() {} });
  const res = response();
  await handler(router, '/company/profile', 'patch')({
    tenant, body: { legalName: 'Impresa Alfa', companyId: 'company-beta' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.equal(queried, false);
});

test('company profile update uses only verified tenant id', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rowCount: 1, rows: [{ legalName: 'Impresa Alfa' }] }; }, connect() {} });
  const res = response();
  await handler(router, '/company/profile', 'patch')({
    tenant, body: { legalName: 'Impresa Alfa', city: 'Milano' }
  }, res, e => { throw e; });
  assert.match(call.sql, /WHERE id = \$3/);
  assert.deepEqual(call.args, ['Impresa Alfa', 'Milano', 'company-alpha']);
  assert.equal(res.statusCode, 200);
});

test('member list joins identities but filters membership by active company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [] }; }, connect() {} });
  const res = response();
  await handler(router, '/company/members', 'get')({ tenant }, res, e => { throw e; });
  assert.match(call.sql, /JOIN app_users u ON u\.id = m\.user_id/);
  assert.match(call.sql, /WHERE m\.company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
});

test('membership update returns not found for a member outside the active company', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id FROM companies')) return { rowCount: 1, rows: [{ id: 'company-alpha' }] };
    if (sql.startsWith('SELECT id, role, status')) return { rowCount: 0, rows: [] };
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/company/members/:membershipId', 'patch')({
    tenant, params: { membershipId: memberId }, body: { role: 'manager' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 404);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(sql => sql.startsWith('UPDATE company_memberships')), false);
});

test('last active administrator cannot be demoted or suspended', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id FROM companies')) return { rowCount: 1, rows: [{ id: 'company-alpha' }] };
    if (sql.startsWith('SELECT id, role, status')) return { rowCount: 1, rows: [{ id: memberId, role: 'admin', status: 'active' }] };
    if (sql.startsWith('SELECT id FROM company_memberships')) return { rowCount: 1, rows: [{ id: memberId }] };
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/company/members/:membershipId', 'patch')({
    tenant, params: { membershipId: memberId }, body: { status: 'suspended' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(sql => sql.startsWith('UPDATE company_memberships')), false);
});

test('membership role update is company-scoped and serialized on company row', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id FROM companies')) return { rowCount: 1, rows: [{ id: 'company-alpha' }] };
    if (sql.startsWith('SELECT id, role, status')) return { rowCount: 1, rows: [{ id: memberId, role: 'operator', status: 'active' }] };
    if (sql.startsWith('UPDATE company_memberships')) return { rowCount: 1, rows: [{ membershipId: memberId, role: 'manager', status: 'active' }] };
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/company/members/:membershipId', 'patch')({
    tenant, params: { membershipId: memberId }, body: { role: 'manager' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.match(calls.find(x => x.sql.startsWith('SELECT id FROM companies')).sql, /FROM companies WHERE id = \\$1 FOR UPDATE/);
  const update = calls.find(x => x.sql.startsWith('UPDATE company_memberships'));
  assert.match(update.sql, /WHERE id = \$2 AND company_id = \$3/);
  assert.equal(update.args[2], 'company-alpha');
  assert.ok(calls.some(x => x.sql === 'COMMIT'));
});
