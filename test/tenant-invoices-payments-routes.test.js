'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-invoices-payments-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function handler(router, path, method) {
  const layer = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  assert.ok(layer, 'missing ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };
const invoiceId = '11111111-1111-4111-8111-111111111111';
const caseId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';

test('invoice list scopes invoice and both linked records to the same tenant', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [] }; }, connect() {} });
  const res = response();
  await handler(router, '/invoices', 'get')({ tenant }, res, e => { throw e; });
  assert.match(call.sql, /c\.id = i\.customer_id AND c\.company_id = i\.company_id/);
  assert.match(call.sql, /f\.id = i\.case_id AND f\.company_id = i\.company_id/);
  assert.match(call.sql, /WHERE i\.company_id = \$1/);
  assert.deepEqual(call.args, ['company-alpha']);
});

test('invoice creation rejects foreign practice and rolls back', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); if (sql.startsWith('SELECT id, customer_id')) return { rowCount: 0, rows: [] }; return { rows: [] }; }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/invoices', 'post')({
    tenant, body: { invoiceNumber: 'FT-1', caseId, amount: 100 }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(sql => sql.startsWith('INSERT INTO invoices')), false);
});

test('invoice creation derives customer from same-tenant practice and sets draft', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id, customer_id')) return { rowCount: 1, rows: [{ customer_id: customerId }] };
    if (sql.startsWith('SELECT id FROM customers')) return { rowCount: 1, rows: [{ id: customerId }] };
    if (sql.startsWith('INSERT INTO invoices')) return { rowCount: 1, rows: [{ id: invoiceId, status: 'draft' }] };
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/invoices', 'post')({
    tenant, body: { invoiceNumber: 'FT-2', caseId, amount: 125.5 }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 201);
  const insert = calls.find(x => x.sql.startsWith('INSERT INTO invoices'));
  assert.equal(insert.args[0], 'company-alpha');
  assert.equal(insert.args[3], customerId);
  assert.match(insert.sql, /'draft'/);
});

test('invoice issue changes only a draft invoice in the active tenant', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rowCount: 0, rows: [] }; }, connect() {} });
  const res = response();
  await handler(router, '/invoices/:id/issue', 'post')({ tenant, params: { id: invoiceId } }, res, e => { throw e; });
  assert.match(call.sql, /WHERE id = \$1 AND company_id = \$2 AND status = 'draft'/);
  assert.deepEqual(call.args, [invoiceId, 'company-alpha']);
  assert.equal(res.statusCode, 404);
});

test('payment history joins invoice and payment by tenant', async () => {
  let call;
  const router = createRouter({ query: async (sql, args) => { call = { sql, args }; return { rows: [] }; }, connect() {} });
  const res = response();
  await handler(router, '/invoices/:id/payments', 'get')({ tenant, params: { id: invoiceId } }, res, e => { throw e; });
  assert.match(call.sql, /i\.id = p\.invoice_id AND i\.company_id = p\.company_id/);
  assert.match(call.sql, /p\.company_id = \$2/);
  assert.deepEqual(call.args, [invoiceId, 'company-alpha']);
});

test('payment is locked, recorded and invoice status recalculated in transaction', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id, amount, status')) return { rowCount: 1, rows: [{ amount: '100.00', status: 'issued' }] };
    if (sql.startsWith('SELECT COALESCE(SUM(amount)')) return { rows: [{ paid: '30.00' }] };
    if (sql.startsWith('INSERT INTO payments')) return { rowCount: 1, rows: [{ id: 'p1', amount: '20.00' }] };
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/invoices/:id/payments', 'post')({
    tenant, params: { id: invoiceId }, body: { amount: 20, method: 'bonifico' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.invoiceStatus, 'partial');
  assert.equal(res.body.paid, '50.00');
  assert.equal(res.body.remaining, '50.00');
  assert.match(calls.find(x => x.sql.startsWith('SELECT id, amount, status')).sql, /company_id = \$2 FOR UPDATE/);
  assert.ok(calls.some(x => x.sql.startsWith('UPDATE invoices SET status = \$1 WHERE id = \$2 AND company_id = \$3')));
  assert.ok(calls.some(x => x.sql === 'COMMIT'));
});

test('payment over the invoice total is rolled back', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id, amount, status')) return { rowCount: 1, rows: [{ amount: '100.00', status: 'issued' }] };
    if (sql.startsWith('SELECT COALESCE(SUM(amount)')) return { rows: [{ paid: '0.00' }] };
    if (sql.startsWith('INSERT INTO payments')) return { rowCount: 1, rows: [{ id: 'p2' }] };
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/invoices/:id/payments', 'post')({
    tenant, params: { id: invoiceId }, body: { amount: 110, method: 'contanti' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.includes('COMMIT'), false);
});

test('draft or cancelled invoice cannot receive a payment', async () => {
  let inserted = false;
  const client = { query: async (sql) => {
    if (sql.startsWith('SELECT id, amount, status')) return { rowCount: 1, rows: [{ amount: '100.00', status: 'draft' }] };
    if (sql.startsWith('INSERT INTO payments')) inserted = true;
    return { rows: [] };
  }, release() {} };
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => client });
  const res = response();
  await handler(router, '/invoices/:id/payments', 'post')({
    tenant, params: { id: invoiceId }, body: { amount: 10, method: 'contanti' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 409);
  assert.equal(inserted, false);
});

test('invoice and payment schemas reject browser-supplied tenant id', async () => {
  let connected = false;
  const router = createRouter({ query: async () => ({ rows: [] }), connect: async () => { connected = true; } });
  const res = response();
  await handler(router, '/invoices', 'post')({
    tenant, body: { invoiceNumber: 'FT-3', amount: 10, companyId: 'company-beta' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});
