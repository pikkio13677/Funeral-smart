'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-customers-cases-routes');

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

test('customer list is restricted to the verified tenant', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => {
    call = { sql, args };
    return { rowCount: 0, rows: [] };
  }});
  const res = response();
  await handler(router, '/customers', 'get')({ tenant }, res, error => { throw error; });
  assert.match(call.sql, /WHERE company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
  assert.deepEqual(res.body, { data: [] });
});

test('customer creation takes company_id from server tenant, not request body', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => {
    call = { sql, args };
    return { rowCount: 1, rows: [{ id: 'customer-1', firstName: 'Ada', lastName: 'Luce' }] };
  }});
  const res = response();
  await handler(router, '/customers', 'post')({
    tenant, body: { firstName: 'Ada', lastName: 'Luce', companyId: 'company-beta' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(call, undefined);
});

test('valid customer creation inserts the verified company id', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => {
    call = { sql, args };
    return { rowCount: 1, rows: [{ id: 'customer-1' }] };
  }});
  const res = response();
  await handler(router, '/customers', 'post')({
    tenant, body: { firstName: 'Ada', lastName: 'Luce' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.match(call.sql, /company_id, first_name/);
  assert.equal(call.args[0], 'company-alpha');
});

test('case list joins customer on both id and tenant and filters the case tenant', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => {
    call = { sql, args };
    return { rowCount: 0, rows: [] };
  }});
  const res = response();
  await handler(router, '/cases', 'get')({ tenant }, res, error => { throw error; });
  assert.match(call.sql, /c\.id = f\.customer_id AND c\.company_id = f\.company_id/);
  assert.match(call.sql, /WHERE f\.company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
});

test('case creation rejects a customer belonging to another company', async () => {
  const calls = [];
  const router = createRouter({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rowCount: 0, rows: [] };
  }});
  const res = response();
  await handler(router, '/cases', 'post')({
    tenant,
    body: {
      caseCode: 'ALFA-1', customerId: '11111111-1111-4111-8111-111111111111',
      deceasedFirstName: 'Mario', deceasedLastName: 'Rossi', serviceType: 'Sepoltura'
    }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE id = \$1 AND company_id = \$2/);
  assert.deepEqual(calls[0].args, ['11111111-1111-4111-8111-111111111111', 'company-alpha']);
});

test('case creation uses server tenant id for insert', async () => {
  const calls = [];
  const router = createRouter({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rowCount: 1, rows: [{ id: 'case-1', caseCode: 'ALFA-2', status: 'open' }] };
  }});
  const res = response();
  await handler(router, '/cases', 'post')({
    tenant,
    body: { caseCode: 'ALFA-2', deceasedFirstName: 'Luca', deceasedLastName: 'Bianchi', serviceType: 'Cremazione' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO funeral_cases\s*\(company_id,/);
  assert.equal(calls[0].args[0], 'company-alpha');
});

test('case status update is constrained by both id and tenant id', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => {
    call = { sql, args };
    return { rowCount: 0, rows: [] };
  }});
  const res = response();
  await handler(router, '/cases/:id/status', 'patch')({
    tenant, params: { id: '22222222-2222-4222-8222-222222222222' }, body: { status: 'completed' }
  }, res, error => { throw error; });
  assert.match(call.sql, /WHERE id = \$2 AND company_id = \$3/);
  assert.deepEqual(call.args, ['completed', '22222222-2222-4222-8222-222222222222', 'company-alpha']);
  assert.equal(res.statusCode, 404);
});

test('router rejects calls without verified tenant context', async () => {
  const router = createRouter({ query: async () => { throw new Error('must not query'); }});
  const guard = router.stack[0].handle;
  const res = response();
  let nextCalled = false;
  guard({}, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});
