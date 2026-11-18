'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createProviderPortalRouter = require('../provider-portal-routes');

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROVIDER_ID = '33333333-3333-4333-8333-333333333333';

async function withServer(router, fn) {
  const app = express();
  app.use('/api/v1/provider-portal', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function fakePool({ accessRows = [{
  providerId: PROVIDER_ID,
  role: 'provider_admin',
  businessName: 'Impresa Alfa'
}], listRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('FROM provider_user_access')) {
        return { rowCount: accessRows.length, rows: accessRows };
      }
      if (sql.includes('COUNT(*) FILTER')) {
        return {
          rowCount: 1,
          rows: [{ newCount: 2, acceptedCount: 1, rejectedCount: 1, activeCount: 4 }]
        };
      }
      if (sql.includes('LIMIT 5')) return { rowCount: listRows.length, rows: listRows };
      if (sql.includes('LIMIT $2 OFFSET $3')) return { rowCount: listRows.length, rows: listRows };
      throw new Error('Unexpected SQL in provider portal test: ' + sql);
    }
  };
}

function authenticate(req, _res, next) {
  if (req.headers.authorization === 'Bearer valid-test-user') {
    req.user = { id: USER_ID };
  }
  next();
}

test('provider profile returns only the authenticated provider context', async () => {
  const pool = fakePool();
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.providerId, PROVIDER_ID);
    assert.equal(body.data.businessName, 'Impresa Alfa');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(body).includes('contact_email'), false);
  });
});

test('provider dashboard scopes every query to the provider resolved from the session', async () => {
  const pool = fakePool({ listRows: [{
    assignmentId: '44444444-4444-4444-8444-444444444444',
    city: 'Torino',
    serviceType: 'burial',
    destinationCountry: null,
    responseStatus: null
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/dashboard?providerId=' + OTHER_PROVIDER_ID, {
      headers: {
        authorization: 'Bearer valid-test-user',
        'x-provider-id': OTHER_PROVIDER_ID
      }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.counts.newCount, 2);
    assert.equal(body.data.recent[0].city, 'Torino');
    const dataQueries = pool.calls.filter(call => !call.sql.includes('FROM provider_user_access'));
    assert.equal(dataQueries.length, 2);
    for (const call of dataQueries) {
      assert.deepEqual(call.args, [PROVIDER_ID]);
      assert.match(call.sql, /assignment\.provider_id = \$1/);
      assert.match(call.sql, /assignment\.status = 'active'/);
      assert.match(call.sql, /inquiry\.status NOT IN \('closed', 'deleted'\)/);
      assert.doesNotMatch(call.sql, /contact_email|contact_phone|inquiry\.notes|budget_euro/);
    }
  });
});

test('inquiry list returns minimized fields and validates pagination strictly', async () => {
  const pool = fakePool({ listRows: [{
    assignmentId: '44444444-4444-4444-8444-444444444444',
    city: 'Torino',
    serviceType: 'burial',
    destinationCountry: null,
    responseStatus: null
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries?limit=20&offset=10', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.length, 1);
    assert.deepEqual(body.pagination, { limit: 20, offset: 10, returned: 1 });
    const query = pool.calls.find(call => call.sql.includes('LIMIT $2 OFFSET $3'));
    assert.deepEqual(query.args, [PROVIDER_ID, 20, 10]);
    assert.doesNotMatch(query.sql, /contact_email|contact_phone|inquiry\.notes|budget_euro/);

    const invalid = await fetch(base + '/api/v1/provider-portal/inquiries?limit=1000&providerId=' + OTHER_PROVIDER_ID, {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    assert.equal(invalid.status, 400);
  });
});

test('unauthenticated provider portal requests are rejected before data queries', async () => {
  const pool = fakePool({ accessRows: [] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries');
    assert.equal(response.status, 401);
    assert.equal(pool.calls.length, 0);
  });
});

test('user without active provider access cannot read the portal', async () => {
  const pool = fakePool({ accessRows: [] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/dashboard', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    assert.equal(response.status, 403);
    assert.equal(pool.calls.length, 1);
  });
});
