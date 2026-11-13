'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-staff-vehicles-routes');

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function handler(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, 'missing route ' + method.toUpperCase() + ' ' + path);
  return layer.route.stack.at(-1).handle;
}

const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };

test('staff list filters by verified company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [], rowCount: 0 }; } });
  const res = response();
  await handler(router, '/staff', 'get')({ tenant }, res, error => { throw error; });
  assert.match(call.sql, /FROM staff WHERE company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
});

test('staff creation ignores no tenant data from browser and injects verified company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [{ id: 's1' }], rowCount: 1 }; } });
  const res = response();
  await handler(router, '/staff', 'post')({
    tenant, body: { firstName: 'Ada', lastName: 'Luce', role: 'Operatrice', companyId: 'company-beta' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(call, undefined);
});

test('valid staff insert uses verified company id', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [{ id: 's1' }], rowCount: 1 }; } });
  const res = response();
  await handler(router, '/staff', 'post')({
    tenant, body: { firstName: 'Ada', lastName: 'Luce', role: 'Operatrice' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.match(call.sql, /INSERT INTO staff\s*\(company_id,/);
  assert.equal(call.args[0], 'company-alpha');
});

test('staff active update is tenant constrained', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [], rowCount: 0 }; } });
  const res = response();
  await handler(router, '/staff/:id/active', 'patch')({
    tenant, params: { id: '11111111-1111-4111-8111-111111111111' }, body: { active: false }
  }, res, error => { throw error; });
  assert.match(call.sql, /WHERE id = \$2 AND company_id = \$3/);
  assert.deepEqual(call.args, [false, '11111111-1111-4111-8111-111111111111', 'company-alpha']);
  assert.equal(res.statusCode, 404);
});

test('vehicle list filters by verified company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [], rowCount: 0 }; } });
  const res = response();
  await handler(router, '/vehicles', 'get')({ tenant }, res, error => { throw error; });
  assert.match(call.sql, /FROM vehicles WHERE company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
});

test('vehicle creation uppercases plate and injects verified company', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [{ id: 'v1' }], rowCount: 1 }; } });
  const res = response();
  await handler(router, '/vehicles', 'post')({
    tenant, body: { plate: 'ab123cd', makeModel: 'Mercedes', companyId: 'company-beta' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(call, undefined);
});

test('valid vehicle insert uses verified company id', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [{ id: 'v1' }], rowCount: 1 }; } });
  const res = response();
  await handler(router, '/vehicles', 'post')({
    tenant, body: { plate: 'ab123cd', makeModel: 'Mercedes' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.match(call.sql, /INSERT INTO vehicles\s*\(company_id,/);
  assert.equal(call.args[0], 'company-alpha');
  assert.equal(call.args[1], 'AB123CD');
});

test('vehicle status update is tenant constrained', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [], rowCount: 0 }; } });
  const res = response();
  await handler(router, '/vehicles/:id/status', 'patch')({
    tenant, params: { id: '22222222-2222-4222-8222-222222222222' }, body: { status: 'maintenance' }
  }, res, error => { throw error; });
  assert.match(call.sql, /WHERE id = \$2 AND company_id = \$3/);
  assert.deepEqual(call.args, ['maintenance', '22222222-2222-4222-8222-222222222222', 'company-alpha']);
  assert.equal(res.statusCode, 404);
});

test('router denies requests without a verified tenant', () => {
  const router = createRouter({ query: async () => { throw new Error('must not query'); } });
  const res = response();
  let nextCalled = false;
  router.stack[0].handle({}, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});
