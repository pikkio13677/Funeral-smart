'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-dashboard-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function handler(router, path, method) {
  const layer = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  assert.ok(layer, 'missing ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
const tenant = { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' };

test('dashboard runs all seven aggregates within the active company', async () => {
  const calls = [];
  const values = [
    { total: 4, active: 2 }, { total: 8 }, { total: 3 },
    { total: 2, available: 1 }, { low: 1 }, { open: 5 }, { outstanding: '125.50' }
  ];
  const pool = { query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: [values[calls.length - 1]] };
  }};
  const router = createRouter(pool);
  const res = response();
  await handler(router, '/dashboard', 'get')({ tenant }, res, e => { throw e; });
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.match(call.sql, /company_id = \$1/);
    assert.deepEqual(call.args, ['company-alpha']);
  }
  const invoiceQuery = calls[6].sql;
  assert.match(invoiceQuery, /p\.company_id = i\.company_id/);
  assert.match(invoiceQuery, /WHERE i\.company_id = \$1/);
  assert.deepEqual(res.body.data, {
    cases: { total: 4, active: 2 },
    customers: { total: 8 },
    activeStaff: 3,
    vehicles: { total: 2, available: 1 },
    lowStock: 1,
    openTasks: 5,
    outstandingEuro: '125.50'
  });
});

test('dashboard rejects requests without verified tenant context', async () => {
  const router = createRouter({ query: async () => { throw new Error('must not query'); } });
  const guard = router.stack[0].handle;
  const res = response();
  let nextCalled = false;
  guard({}, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('dashboard permits an authorized accounting membership', async () => {
  let queries = 0;
  const router = createRouter({ query: async () => { queries += 1; return { rows: [{}] }; } });
  const res = response();
  await handler(router, '/dashboard', 'get')({
    tenant: { companyId: 'company-alpha', membershipId: 'member-accounting', role: 'accounting' }
  }, res, e => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.equal(queries, 7);
});
