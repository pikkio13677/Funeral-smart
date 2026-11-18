'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../platform-marketplace-routes');

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const INQUIRY_ID = '33333333-3333-4333-8333-333333333333';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

function authOptions(role = 'owner') {
  return {
    authenticate(req, _res, next) {
      req.user = { id: USER_ID, username: 'platform-owner' };
      next();
    },
    requirePlatformRole(required) {
      return (_req, res, next) => role === required ? next() : res.status(403).json({ error: 'Forbidden' });
    }
  };
}

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, args) {
      calls.push({ sql, args });
      return handler(sql, args);
    },
    release() {}
  };
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args, pool: true });
      return handler(sql, args);
    },
    async connect() { return client; }
  };
}

test('non-owner cannot access provider applications', async () => {
  let queried = false;
  const pool = {
    async query() { queried = true; return { rowCount: 0, rows: [] }; },
    async connect() { throw new Error('unexpected connection'); }
  };
  await withServer(createRouter(pool, authOptions('support')), async base => {
    const response = await fetch(base + '/api/v1/platform/provider-applications');
    assert.equal(response.status, 403);
    assert.equal(queried, false);
  });
});

test('provider application approval creates a private pending provider and audits atomically', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,business_name')) return {
      rowCount: 1,
      rows: [{
        id: APPLICATION_ID, business_name: 'Impresa Test', vat_number: 'IT12345678901',
        city: 'Torino', province: 'TO', email: 'test@example.invalid', phone: '011000000',
        website: null, status: 'pending'
      }]
    };
    if (sql.startsWith('SELECT id FROM providers')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO providers')) return {
      rowCount: 1,
      rows: [{ id: PROVIDER_ID, businessName: 'Impresa Test', status: 'pending' }]
    };
    return { rowCount: 1, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/provider-applications/' + APPLICATION_ID + '/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Documentazione iniziale controllata' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.status, 'pending');
    assert.match(body.message, /non è pubblica/);
    assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO platform_audit_log')));
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  });
});

test('provider approval rejects duplicate VAT number without creating a provider', async () => {
  let inserted = false;
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,business_name')) return {
      rowCount: 1,
      rows: [{ id: APPLICATION_ID, vat_number: 'IT12345678901', status: 'pending' }]
    };
    if (sql.startsWith('SELECT id FROM providers')) return { rowCount: 1, rows: [{ id: PROVIDER_ID }] };
    if (sql.startsWith('INSERT INTO providers')) inserted = true;
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/provider-applications/' + APPLICATION_ID + '/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Verifica partita IVA già esistente' })
    });
    assert.equal(response.status, 409);
    assert.equal(inserted, false);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  });
});

test('provider verification requires explicit document review confirmation', async () => {
  let connected = false;
  const pool = {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() { connected = true; throw new Error('must not connect'); }
  };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/providers/' + PROVIDER_ID + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Controllo documenti effettuato' })
    });
    assert.equal(response.status, 400);
    assert.equal(connected, false);
  });
});

test('verified provider publication is audited in the same transaction', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT pl.id,p.status')) return { rowCount: 1, rows: [{ id: '55555555-5555-4555-8555-555555555555', providerStatus: 'verified' }] };
    if (sql.startsWith('UPDATE price_lists')) return { rowCount: 1, rows: [{ id: '55555555-5555-4555-8555-555555555555', published: true }] };
    return { rowCount: 1, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/price-lists/55555555-5555-4555-8555-555555555555/publication', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published: true, reason: 'Listino verificato e pronto alla pubblicazione' })
    });
    assert.equal(response.status, 200);
    assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO platform_audit_log')));
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  });
});

test('inquiry status changes require a reason and roll back if audit cannot be written', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN') return { rowCount: 0, rows: [] };
    if (sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'received' }] };
    if (sql.startsWith('UPDATE inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'reviewed' }] };
    if (sql.startsWith('INSERT INTO platform_audit_log')) throw new Error('audit unavailable');
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'reviewed', reason: 'Richiesta presa in carico' })
    });
    assert.equal(response.status, 500);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
    const invalid = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'reviewed' })
    });
    assert.equal(invalid.status, 400);
  });
});

test('price list creation refuses unverified providers', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM providers')) return { rowCount: 1, rows: [{ id: PROVIDER_ID, status: 'pending' }] };
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/price-lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: PROVIDER_ID,
        serviceTypeId: SERVICE_ID,
        title: 'Listino di prova',
        totalEuro: 1500,
        includedItems: [],
        excludedItems: []
      })
    });
    assert.equal(response.status, 409);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
    assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO price_lists')), false);
  });
});


test('inquiry list hides logically deleted records unless explicitly requested', async () => {
  let captured;
  const pool = {
    async query(sql, args) { captured = { sql, args }; return { rowCount: 0, rows: [] }; },
    async connect() { throw new Error('unexpected'); }
  };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries');
    assert.equal(response.status, 200);
    assert.match(captured.sql, /status <> 'deleted'/);
    assert.deepEqual(captured.args, [null, 50]);
    const deleted = await fetch(base + '/api/v1/platform/inquiries?status=deleted');
    assert.equal(deleted.status, 200);
    assert.deepEqual(captured.args, ['deleted', 50]);
  });
});

test('closed inquiries cannot be reopened through the status endpoint', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'closed' }] };
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'reviewed', reason: 'Verifica del cambio di stato' })
    });
    assert.equal(response.status, 409);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
    assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE inquiries')), false);
  });
});


test('inquiry assignment requires a verified provider and records the assignment atomically', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'reviewed' }] };
    if (sql.startsWith('SELECT id,status FROM providers')) return { rowCount: 1, rows: [{ id: PROVIDER_ID, status: 'verified' }] };
    if (sql.startsWith('INSERT INTO inquiry_provider_assignments')) return {
      rowCount: 1,
      rows: [{ id: '66666666-6666-4666-8666-666666666666', providerId: PROVIDER_ID, status: 'active' }]
    };
    return { rowCount: 1, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER_ID, reason: 'Impresa verificata selezionata per competenza' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.providerId, PROVIDER_ID);
    assert.ok(pool.calls.some(call => call.sql.startsWith("UPDATE inquiries SET status='assigned'")));
    assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO platform_audit_log') && call.args[2] === 'platform.inquiry.assigned'));
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  });
});

test('inquiry assignment refuses unverified providers without writing an assignment', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'received' }] };
    if (sql.startsWith('SELECT id,status FROM providers')) return { rowCount: 1, rows: [{ id: PROVIDER_ID, status: 'pending' }] };
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER_ID, reason: 'Tentativo impresa non ancora verificata' })
    });
    assert.equal(response.status, 409);
    assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO inquiry_provider_assignments')), false);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  });
});

test('inquiry assignment refuses a second active assignment and invalid states', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'assigned' }] };
    return { rowCount: 0, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER_ID, reason: 'Tentativo di riassegnazione senza revoca' })
    });
    assert.equal(response.status, 409);
    assert.equal(pool.calls.some(call => call.sql.startsWith('SELECT id,status FROM providers')), false);
    assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO inquiry_provider_assignments')), false);
  });
});

test('closing an assigned inquiry revokes its active assignment and audits both actions', async () => {
  const pool = fakePool(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT id,status FROM inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'assigned' }] };
    if (sql.startsWith("UPDATE inquiry_provider_assignments SET status='revoked'")) return { rowCount: 1, rows: [{ id: '66666666-6666-4666-8666-666666666666' }] };
    if (sql.startsWith('UPDATE inquiries')) return { rowCount: 1, rows: [{ id: INQUIRY_ID, status: 'closed' }] };
    return { rowCount: 1, rows: [] };
  });
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries/' + INQUIRY_ID + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed', reason: 'La famiglia ha concluso il percorso' })
    });
    assert.equal(response.status, 200);
    assert.ok(pool.calls.some(call => call.sql.startsWith("UPDATE inquiry_provider_assignments SET status='revoked'")));
    assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO platform_audit_log') && call.args[2] === 'platform.inquiry.assignment_revoked'));
    assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO platform_audit_log') && call.args[2] === 'platform.inquiry.status_changed'));
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  });
});

test('inquiry list exposes only the active assigned provider details', async () => {
  let capturedSql = '';
  const pool = {
    async query(sql) {
      capturedSql = sql;
      return { rowCount: 0, rows: [] };
    },
    async connect() { throw new Error('unexpected'); }
  };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/inquiries');
    assert.equal(response.status, 200);
    assert.match(capturedSql, /inquiry_provider_assignments/);
    assert.match(capturedSql, /status='active'/);
    assert.match(capturedSql, /assignedProviderName/);
  });
});
