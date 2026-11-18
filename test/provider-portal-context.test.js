'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createProviderContext = require('../provider-portal-context');

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';

async function withServer(middleware, fn) {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers.authorization === 'Bearer valid-test-user') req.user = { id: USER_ID };
    next();
  });
  app.use('/portal', middleware, (req, res) => res.json({ provider: req.provider }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      return { rowCount: rows.length, rows };
    }
  };
}

test('unauthenticated requests are rejected before querying provider access', async () => {
  const pool = poolReturning([]);
  await withServer(createProviderContext(pool), async base => {
    const response = await fetch(base + '/portal');
    assert.equal(response.status, 401);
    assert.equal(pool.calls.length, 0);
  });
});

test('user without active verified provider access is forbidden', async () => {
  const pool = poolReturning([]);
  await withServer(createProviderContext(pool), async base => {
    const response = await fetch(base + '/portal', { headers: { authorization: 'Bearer valid-test-user' } });
    assert.equal(response.status, 403);
    assert.deepEqual(pool.calls[0].args, [USER_ID]);
  });
});

test('provider identity is derived from the authenticated user, not a spoofed request value', async () => {
  const pool = poolReturning([{
    providerId: PROVIDER_ID,
    role: 'provider_admin',
    businessName: 'Impresa Alfa'
  }]);
  await withServer(createProviderContext(pool), async base => {
    const response = await fetch(base + '/portal?providerId=33333333-3333-4333-8333-333333333333', {
      headers: {
        authorization: 'Bearer valid-test-user',
        'x-provider-id': '33333333-3333-4333-8333-333333333333'
      }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider.providerId, PROVIDER_ID);
    assert.deepEqual(pool.calls[0].args, [USER_ID]);
    assert.match(pool.calls[0].sql, /access\.status = 'active'/);
    assert.match(pool.calls[0].sql, /provider\.status = 'verified'/);
  });
});

test('ambiguous multiple provider memberships fail closed', async () => {
  const pool = poolReturning([
    { providerId: PROVIDER_ID, role: 'provider_admin', businessName: 'Impresa Alfa' },
    { providerId: '33333333-3333-4333-8333-333333333333', role: 'provider_operator', businessName: 'Impresa Beta' }
  ]);
  await withServer(createProviderContext(pool), async base => {
    const response = await fetch(base + '/portal', { headers: { authorization: 'Bearer valid-test-user' } });
    assert.equal(response.status, 409);
  });
});
