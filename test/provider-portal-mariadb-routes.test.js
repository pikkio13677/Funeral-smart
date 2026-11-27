'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../provider-portal-mariadb/routes');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const ASSIGNMENT = '44444444-4444-4444-8444-444444444444';

function makeDatabase({ providerRows = [{ providerId: PROVIDER, role: 'provider_admin', businessName: 'Impresa Test' }], inquiryRows = [] } = {}) {
  const calls = [];
  const database = {
    calls,
    async query(sql, values) {
      calls.push({ kind: 'query', sql, values });
      if (/FROM provider_user_access/.test(sql)) return [providerRows, []];
      if (/FROM inquiry_provider_assignments/.test(sql)) return [inquiryRows, []];
      return [[], []];
    },
    async withTransaction(work) {
      const connection = {
        async execute(sql, values) {
          calls.push({ kind: 'execute', sql, values });
          if (/SELECT assignment\.id/.test(sql)) return [[{ id: ASSIGNMENT }], []];
          if (/SELECT id FROM provider_inquiry_responses/.test(sql)) return [[], []];
          if (/SELECT id, assignment_id/.test(sql)) return [[{
            id: '55555555-5555-4555-8555-555555555555',
            assignmentId: ASSIGNMENT,
            status: 'accepted',
            respondedAt: '2026-11-20 12:00:00.000'
          }], []];
          return [{ affectedRows: 1 }, []];
        }
      };
      return work(connection);
    }
  };
  return database;
}

async function withServer(database, fn) {
  const app = express();
  app.use(express.json());
  const authenticate = (req, _res, next) => {
    if (req.headers.authorization === 'Bearer test') req.user = { id: USER };
    next();
  };
  app.use('/portal', createRouter(database, { authenticate }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('router rifiuta la configurazione senza adapter transazionale', () => {
  assert.throws(() => createRouter({ query() {} }, { authenticate(_req, _res, next) { next(); } }), /withTransaction/);
});

test('GET /me restituisce i permessi coerenti con il ruolo autenticato', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/me', { headers: { authorization: 'Bearer test' } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.providerId, PROVIDER);
    assert.equal(body.data.permissions.manageMembers, true);
  });
});

test('GET /inquiries limita sempre i risultati al provider della sessione', async () => {
  const database = makeDatabase({ inquiryRows: [{ assignmentId: ASSIGNMENT, city: 'Torino' }] });
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/inquiries?limit=10&offset=0', {
      headers: { authorization: 'Bearer test' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data[0].assignmentId, ASSIGNMENT);
    const listQuery = database.calls.find(call => call.kind === 'query' && /FROM inquiry_provider_assignments/.test(call.sql));
    assert.match(listQuery.sql, /assignment\.provider_id = \?/);
    assert.deepEqual(listQuery.values, [PROVIDER, 10, 0]);
    assert.doesNotMatch(listQuery.sql, /\$[0-9]/);
  });
});

test('GET /inquiries/:id non espone contatti finché la risposta non è accettata', async () => {
  const database = makeDatabase({ inquiryRows: [] });
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/inquiries/' + ASSIGNMENT, {
      headers: { authorization: 'Bearer test' }
    });
    assert.equal(response.status, 404);
    const query = database.calls.find(call => call.kind === 'query' && /contactEmail/.test(call.sql));
    assert.deepEqual(query.values, [ASSIGNMENT, PROVIDER]);
    assert.match(query.sql, /response\.status = 'accepted'/);
  });
});

test('POST /inquiries/:id/response scrive risposta e audit nella stessa transazione', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/inquiries/' + ASSIGNMENT + '/response', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'accepted', reason: 'Confermiamo la disponibilità del servizio.' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.assignmentId, ASSIGNMENT);
    const writes = database.calls.filter(call => call.kind === 'execute');
    assert.equal(writes.filter(call => /INSERT INTO provider_inquiry_responses/.test(call.sql)).length, 1);
    assert.equal(writes.filter(call => /INSERT INTO provider_portal_audit_log/.test(call.sql)).length, 1);
    assert.ok(writes.every(call => !/\$[0-9]/.test(call.sql)));
  });
});

test('GET /dashboard/analytics è disponibile solo agli amministratori e usa query per provider', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/dashboard/analytics', {
      headers: { authorization: 'Bearer test' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.summary.monthRequests, 0);
    const analytics = database.calls.find(call => call.kind === 'query' && /averageResponseHours/.test(call.sql));
    assert.ok(analytics);
    assert.equal(analytics.values.length, 5);
    assert.ok(analytics.sql.includes('provider_id = ?'));
    assert.doesNotMatch(analytics.sql, /\$[0-9]/);
  });
});

test('GET /activity limita il registro all’impresa autenticata', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/portal/activity?limit=10&offset=0', {
      headers: { authorization: 'Bearer test' }
    });
    assert.equal(response.status, 200);
    const query = database.calls.find(call => call.kind === 'query' && /FROM provider_portal_audit_log/.test(call.sql));
    assert.deepEqual(query.values, [PROVIDER, 10, 0]);
    assert.match(query.sql, /audit\.provider_id = \?/);
  });
});

test('gli operatori non possono leggere analytics o registro attività', async () => {
  const database = makeDatabase({ providerRows: [{ providerId: PROVIDER, role: 'provider_operator', businessName: 'Impresa Test' }] });
  await withServer(database, async base => {
    const analytics = await fetch(base + '/portal/dashboard/analytics', { headers: { authorization: 'Bearer test' } });
    const activity = await fetch(base + '/portal/activity', { headers: { authorization: 'Bearer test' } });
    assert.equal(analytics.status, 403);
    assert.equal(activity.status, 403);
  });
});
