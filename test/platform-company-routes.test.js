'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../platform-company-routes');
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

async function withServer(router, fn) {
  const app = express(); app.use(express.json()); app.use('/api/v1/platform', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
function authOptions(role = 'owner') {
  return {
    authenticate(req, _res, next) { req.user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'platform-owner' }; next(); },
    requirePlatformRole(required) { return (_req, res, next) => role === required ? next() : res.status(403).json({ error: 'Forbidden' }); }
  };
}

test('non-owner cannot query platform companies', async () => {
  let queried = false;
  const pool = { query: async () => { queried = true; return { rowCount: 0, rows: [] }; }, connect: async () => { throw new Error('unexpected'); } };
  await withServer(createRouter(pool, authOptions('support')), async base => {
    const response = await fetch(base + '/api/v1/platform/companies');
    assert.equal(response.status, 403); assert.equal(queried, false);
  });
});

test('company list applies bounded filters and cursor pagination', async () => {
  let values;
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', legalName: 'Impresa A', createdAt: '2026-01-03T10:00:00.000Z' },
    { id: '22222222-2222-4222-8222-222222222222', legalName: 'Impresa B', createdAt: '2026-01-02T10:00:00.000Z' },
    { id: '33333333-3333-4333-8333-333333333333', legalName: 'Impresa C', createdAt: '2026-01-01T10:00:00.000Z' }
  ];
  const pool = { query: async (_sql, args) => { values = args; return { rowCount: 3, rows }; }, connect: async () => { throw new Error('unexpected'); } };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/companies?status=active&q=Impresa&limit=2');
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.data.length, 2);
    assert.equal(body.page.hasMore, true); assert.ok(body.page.nextCursor);
    assert.equal(values[0], 'active'); assert.equal(values[1], 'Impresa'); assert.equal(values[4], 3);
    assert.equal((await fetch(base + '/api/v1/platform/companies?status=archived')).status, 400);
    assert.equal((await fetch(base + '/api/v1/platform/companies?limit=1000')).status, 400);
  });
});

test('members endpoint returns only limited identity and membership fields', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id FROM companies')) return { rowCount: 1, rows: [{ id: COMPANY_ID }] };
    return { rowCount: 1, rows: [{ userId: 'u1', username: 'staff', displayName: 'Staff', role: 'operator', status: 'active' }] };
  }, connect: async () => { throw new Error('unexpected'); } };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/companies/' + COMPANY_ID + '/members');
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.data[0].username, 'staff');
    assert.equal('passwordHash' in body.data[0], false); assert.equal('email' in body.data[0], false);
    assert.equal(calls[1].args[0], COMPANY_ID);
  });
});

test('status update and reason audit commit in the same transaction', async () => {
  const statements = [];
  const client = { async query(sql, args) {
    statements.push({ sql, args });
    if (sql.startsWith('SELECT id,status FROM companies')) return { rowCount: 1, rows: [{ id: COMPANY_ID, status: 'active' }] };
    if (sql.startsWith('UPDATE companies')) return { rowCount: 1, rows: [{ id: COMPANY_ID, status: 'suspended', updatedAt: '2026-01-01T00:00:00Z' }] };
    if (sql.startsWith('INSERT INTO platform_audit_log')) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const pool = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/companies/' + COMPANY_ID + '/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Richiesta amministrativa verificata' })
    });
    assert.equal(response.status, 200); assert.equal(statements[0].sql, 'BEGIN');
    const audit = statements.find(item => item.sql.startsWith('INSERT INTO platform_audit_log'));
    assert.ok(audit); assert.equal(audit.args[5], 'Richiesta amministrativa verificata');
    assert.equal(statements.at(-1).sql, 'COMMIT');
  });
});

test('status update rolls back if the audit insert fails', async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.startsWith('SELECT id,status FROM companies')) return { rowCount: 1, rows: [{ id: COMPANY_ID, status: 'active' }] };
    if (sql.startsWith('INSERT INTO platform_audit_log')) throw new Error('audit unavailable');
    if (sql.startsWith('UPDATE companies')) return { rowCount: 1, rows: [{ id: COMPANY_ID, status: 'suspended' }] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const pool = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/companies/' + COMPANY_ID + '/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Richiesta amministrativa verificata' })
    });
    assert.equal(response.status, 500); assert.ok(statements.includes('ROLLBACK'));
    assert.equal(statements.at(-1), 'ROLLBACK');
  });
});

test('status endpoint rejects malformed id and missing reason', async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => { throw new Error('unexpected'); } };
  await withServer(createRouter(pool, authOptions()), async base => {
    const badId = await fetch(base + '/api/v1/platform/companies/not-a-uuid/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Motivazione valida e dettagliata' })
    });
    assert.equal(badId.status, 400);
    const noReason = await fetch(base + '/api/v1/platform/companies/' + COMPANY_ID + '/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'suspended' })
    });
    assert.equal(noReason.status, 400);
  });
});

test('audit endpoint returns minimized records with bounded filters and cursor pagination', async () => {
  let query;
  const rows = [
    { id: '12', actorUserId: 'u1', actorUsername: 'owner', action: 'platform.company.suspended', resource: 'company', resourceId: COMPANY_ID, reason: 'Motivo verificato', createdAt: '2026-01-03T10:00:00.000Z' },
    { id: '11', actorUserId: 'u1', actorUsername: 'owner', action: 'platform.company.reactivated', resource: 'company', resourceId: COMPANY_ID, reason: 'Ripristino verificato', createdAt: '2026-01-02T10:00:00.000Z' },
    { id: '10', actorUserId: 'u1', actorUsername: 'owner', action: 'platform.company.suspended', resource: 'company', resourceId: COMPANY_ID, reason: 'Altro motivo verificato', createdAt: '2026-01-01T10:00:00.000Z' }
  ];
  const pool = { query: async (sql, values) => { query = { sql, values }; return { rowCount: 3, rows }; }, connect: async () => { throw new Error('unexpected'); } };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/audit?action=platform.company.suspended&resource=company&resourceId=' + COMPANY_ID + '&limit=2');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.page.hasMore, true);
    assert.ok(body.page.nextCursor);
    assert.ok(query.sql.includes('ORDER BY created_at DESC,id DESC'));
    assert.deepEqual(query.values.slice(0, 3), ['platform.company.suspended', 'company', COMPANY_ID]);
    assert.equal('ipAddress' in body.data[0], false);
    assert.equal((await fetch(base + '/api/v1/platform/audit?action=unknown')).status, 400);
    assert.equal((await fetch(base + '/api/v1/platform/audit?resourceId=bad')).status, 400);
  });
});


test('audit cursor rejects BIGSERIAL overflow and unexpected fields', () => {
  const { decodeAuditCursor } = require('../platform-company-routes');
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const valid = { createdAt: '2026-01-03T10:00:00.000Z', id: '9223372036854775807' };
  assert.deepEqual(decodeAuditCursor(encode(valid)), valid);
  assert.equal(decodeAuditCursor(encode({ ...valid, id: '9223372036854775808' })), undefined);
  assert.equal(decodeAuditCursor(encode({ ...valid, extra: 'ignored-before-hardening' })), undefined);
});


test('audit filters accept platform marketplace actions and resource types', async () => {
  let captured;
  const pool = {
    query: async (sql, values) => {
      captured = { sql, values };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => { throw new Error('unexpected'); }
  };
  await withServer(createRouter(pool, authOptions()), async base => {
    const response = await fetch(base + '/api/v1/platform/audit?action=platform.provider_application.approved&resource=provider_application&resourceId=' + COMPANY_ID);
    assert.equal(response.status, 200);
    assert.deepEqual(captured.values, ['platform.provider_application.approved', 'provider_application', COMPANY_ID, 26]);
  });
});
