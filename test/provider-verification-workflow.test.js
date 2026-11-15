'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createAdminRouter = require('../admin-routes');

const applicationId = '11111111-1111-4111-8111-111111111111';
const providerId = '22222222-2222-4222-8222-222222222222';

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function route(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, 'missing ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}

function clientWith(query) {
  const calls = [];
  return {
    calls,
    client: {
      async query(sql, args) { calls.push({ sql, args }); return query(sql, args); },
      release() {}
    }
  };
}

test('approval creates a pending provider and atomically approves the application', async () => {
  const { calls, client } = clientWith(async sql => {
    if (sql.startsWith('SELECT id, business_name')) return { rowCount: 1, rows: [{
      id: applicationId, business_name: 'Impresa Test', vat_number: 'IT12345678901',
      city: 'Milano', province: 'MI', email: 'test@example.invalid', phone: '020000000',
      website: null, status: 'pending'
    }] };
    if (sql.startsWith('SELECT id FROM providers')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO providers')) return { rowCount: 1, rows: [{
      id: providerId, businessName: 'Impresa Test', status: 'pending', verificationDate: null
    }] };
    return { rowCount: 1, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const handler = route(createAdminRouter(pool, (_req, _res, next) => next()), '/provider-applications/:id/approve', 'post');
  const res = response();
  await handler({ params: { id: applicationId } }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.status, 'pending');
  assert.match(res.body.message, /non è pubblica/);
  assert.ok(calls.some(call => call.sql === 'BEGIN'));
  assert.ok(calls.some(call => call.sql.startsWith('UPDATE provider_applications SET status = \'approved\'')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.ok(calls.some(call => call.sql.includes("VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')")));
});

test('approval refuses a duplicate VAT number already in providers', async () => {
  let inserted = false;
  const { calls, client } = clientWith(async sql => {
    if (sql.startsWith('SELECT id, business_name')) return { rowCount: 1, rows: [{
      id: applicationId, vat_number: 'IT12345678901', status: 'pending'
    }] };
    if (sql.startsWith('SELECT id FROM providers')) return { rowCount: 1, rows: [{ id: providerId }] };
    if (sql.startsWith('INSERT INTO providers')) inserted = true;
    return { rowCount: 0, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const handler = route(createAdminRouter(pool, (_req, _res, next) => next()), '/provider-applications/:id/approve', 'post');
  const res = response();
  await handler({ params: { id: applicationId } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(inserted, false);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('provider verification requires explicit confirmation that documents were reviewed', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('must not connect'); }, query: async () => ({ rows: [] }) };
  const handler = route(createAdminRouter(pool, (_req, _res, next) => next()), '/providers/:id/verify', 'post');
  const res = response();
  await handler({ params: { id: providerId }, body: {} }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('verification locks and changes only a pending provider to verified', async () => {
  const { calls, client } = clientWith(async sql => {
    if (sql.startsWith('SELECT id, status FROM providers')) return { rowCount: 1, rows: [{ id: providerId, status: 'pending' }] };
    if (sql.startsWith('UPDATE providers SET status')) return { rowCount: 1, rows: [{
      id: providerId, businessName: 'Impresa Test', status: 'verified', verificationDate: new Date()
    }] };
    return { rowCount: 1, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const handler = route(createAdminRouter(pool, (_req, _res, next) => next()), '/providers/:id/verify', 'post');
  const res = response();
  await handler({ params: { id: providerId }, body: { documentsReviewed: true } }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'verified');
  assert.ok(calls.some(call => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('verification refuses providers that are not pending', async () => {
  const { calls, client } = clientWith(async sql => {
    if (sql.startsWith('SELECT id, status FROM providers')) return { rowCount: 1, rows: [{ id: providerId, status: 'verified' }] };
    return { rowCount: 0, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const handler = route(createAdminRouter(pool, (_req, _res, next) => next()), '/providers/:id/verify', 'post');
  const res = response();
  await handler({ params: { id: providerId }, body: { documentsReviewed: true } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE providers SET status')), false);
});
