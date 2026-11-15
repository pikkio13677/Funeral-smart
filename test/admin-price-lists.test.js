'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createAdminRouter = require('../admin-routes');

const providerId = '11111111-1111-4111-8111-111111111111';
const serviceTypeId = '22222222-2222-4222-8222-222222222222';
const priceListId = '33333333-3333-4333-8333-333333333333';

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}
function handler(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, 'missing ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
function fakeClient(query) {
  const calls = [];
  return { calls, client: {
    async query(sql, args) { calls.push({ sql, args }); return query(sql, args); },
    release() {}
  }};
}

test('price list creation rejects unverified providers', async () => {
  const { client, calls } = fakeClient(async sql => {
    if (sql.startsWith('SELECT id, status FROM providers')) return { rowCount: 1, rows: [{ id: providerId, status: 'pending' }] };
    return { rowCount: 0, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const run = handler(createAdminRouter(pool, (_req, _res, next) => next()), '/price-lists', 'post');
  const res = response();
  await run({ body: { providerId, serviceTypeId, title: 'Listino prova' } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO price_lists')), false);
});

test('price list creation saves a verified provider list as unpublished draft', async () => {
  const { client, calls } = fakeClient(async sql => {
    if (sql.startsWith('SELECT id, status FROM providers')) return { rowCount: 1, rows: [{ id: providerId, status: 'verified' }] };
    if (sql.startsWith('SELECT id FROM service_types')) return { rowCount: 1, rows: [{ id: serviceTypeId }] };
    if (sql.startsWith('INSERT INTO price_lists')) return { rowCount: 1, rows: [{ id: priceListId, published: false }] };
    return { rowCount: 1, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const run = handler(createAdminRouter(pool, (_req, _res, next) => next()), '/price-lists', 'post');
  const res = response();
  await run({ body: {
    providerId, serviceTypeId, title: 'Listino prova', totalEuro: 1800,
    vatIncluded: true, includedItems: ['Cofano'], excludedItems: ['Diritti comunali']
  } }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.published, false);
  assert.ok(calls.some(call => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO price_lists'));
  assert.match(insert.sql, /published\)\s*VALUES[\s\S]*FALSE/);
  assert.deepEqual(JSON.parse(insert.args[5]), ['Cofano']);
});

test('price list rejects reversed validity dates before database access', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('must not connect'); }, query: async () => ({ rows: [] }) };
  const run = handler(createAdminRouter(pool, (_req, _res, next) => next()), '/price-lists', 'post');
  const res = response();
  await run({ body: { providerId, serviceTypeId, title: 'Listino prova', validFrom: '2027-12-31', validUntil: '2027-01-01' } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('price list cannot be published while provider is not verified', async () => {
  const { client, calls } = fakeClient(async sql => {
    if (sql.startsWith('SELECT pl.id')) return { rowCount: 1, rows: [{ id: priceListId, providerStatus: 'pending' }] };
    return { rowCount: 0, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const run = handler(createAdminRouter(pool, (_req, _res, next) => next()), '/price-lists/:id/publication', 'patch');
  const res = response();
  await run({ params: { id: priceListId }, body: { published: true } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE price_lists')), false);
});

test('verified provider price list can be published and unpublished', async () => {
  const { client, calls } = fakeClient(async sql => {
    if (sql.startsWith('SELECT pl.id')) return { rowCount: 1, rows: [{ id: priceListId, providerStatus: 'verified' }] };
    if (sql.startsWith('UPDATE price_lists')) return { rowCount: 1, rows: [{ id: priceListId, published: true }] };
    return { rowCount: 1, rows: [] };
  });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const run = handler(createAdminRouter(pool, (_req, _res, next) => next()), '/price-lists/:id/publication', 'patch');
  const res = response();
  await run({ params: { id: priceListId }, body: { published: true } }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.published, true);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});
