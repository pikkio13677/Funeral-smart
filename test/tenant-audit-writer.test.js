'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createTenantAuditWriter = require('../tenant-audit-writer');

function request(overrides = {}) {
  return {
    method: 'POST',
    path: '/cases/11111111-1111-4111-8111-111111111111/status',
    params: {},
    user: { id: 'user-alpha', username: 'admin-alpha' },
    tenant: { companyId: 'company-alpha', membershipId: 'member-alpha', role: 'admin' },
    ip: '127.0.0.1',
    ...overrides
  };
}

test('successful tenant mutation writes a scoped audit event without request body data', async () => {
  const calls = [];
  const middleware = createTenantAuditWriter({
    query: async (sql, values) => { calls.push({ sql, values }); }
  });
  const req = request({ body: { deceasedFirstName: 'PRIVATE_NAME', notes: 'PRIVATE_NOTE' } });
  const res = new EventEmitter();
  res.statusCode = 201;
  let continued = false;

  middleware(req, res, () => { continued = true; });
  assert.equal(continued, true);
  res.emit('finish');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /company_id, membership_id, ip_address/);
  assert.deepEqual(calls[0].values, [
    'user-alpha', 'admin-alpha', 'tenant.cases.update', 'cases',
    '11111111-1111-4111-8111-111111111111', 'company-alpha', 'member-alpha', '127.0.0.1'
  ]);
  assert.equal(JSON.stringify(calls[0].values).includes('PRIVATE_NAME'), false);
  assert.equal(JSON.stringify(calls[0].values).includes('PRIVATE_NOTE'), false);
});

test('read requests and unsuccessful mutations do not create audit events', async () => {
  let writes = 0;
  const middleware = createTenantAuditWriter({ query: async () => { writes += 1; } });

  const getResponse = new EventEmitter();
  getResponse.statusCode = 200;
  middleware(request({ method: 'GET' }), getResponse, () => {});
  getResponse.emit('finish');

  const failedResponse = new EventEmitter();
  failedResponse.statusCode = 400;
  middleware(request(), failedResponse, () => {});
  failedResponse.emit('finish');

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('requests without a verified tenant are not logged', () => {
  let writes = 0;
  const middleware = createTenantAuditWriter({ query: async () => { writes += 1; } });
  const res = new EventEmitter();
  res.statusCode = 201;
  middleware(request({ tenant: null }), res, () => {});
  res.emit('finish');
  assert.equal(writes, 0);
});
