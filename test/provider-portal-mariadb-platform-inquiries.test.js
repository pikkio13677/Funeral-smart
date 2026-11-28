'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../provider-portal-mariadb/platform-inquiry-routes');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INQUIRY = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const ASSIGNMENT = '33333333-3333-4333-8333-333333333333';

function makeDatabase() {
  const calls = [];
  let inquiryStatus = 'received';
  let activeAssignment = false;
  const database = {
    calls,
    async query(sql, values) {
      calls.push({ kind: 'query', sql, values });
      if (/FROM providers WHERE status = 'verified'/.test(sql)) {
        return [[{ id: PROVIDER, businessName: 'Impresa verificata', city: 'Torino' }], []];
      }
      if (/FROM inquiries i/.test(sql)) {
        return [[{ id: INQUIRY, city: 'Torino', status: inquiryStatus }], []];
      }
      if (/FROM inquiry_provider_assignments a/.test(sql)) return [[], []];
      return [[], []];
    },
    async withTransaction(work) {
      const connection = {
        async execute(sql, values) {
          calls.push({ kind: 'execute', sql, values });
          if (/SELECT id, status FROM inquiries/.test(sql)) return [[{ id: INQUIRY, status: inquiryStatus }], []];
          if (/SELECT id FROM inquiry_provider_assignments/.test(sql)) return [activeAssignment ? [{ id: ASSIGNMENT }] : [], []];
          if (/SELECT id FROM providers/.test(sql)) return [[{ id: PROVIDER }], []];
          if (/INSERT INTO inquiry_provider_assignments/.test(sql)) { activeAssignment = true; inquiryStatus = 'assigned'; return [{ affectedRows: 1 }, []]; }
          if (/UPDATE inquiry_provider_assignments/.test(sql)) { activeAssignment = false; return [{ affectedRows: 1 }, []]; }
          if (/UPDATE inquiries SET status = 'assigned'/.test(sql)) { inquiryStatus = 'assigned'; return [{ affectedRows: 1 }, []]; }
          if (/UPDATE inquiries SET status = \?/.test(sql)) { inquiryStatus = values[0]; return [{ affectedRows: 1 }, []]; }
          if (/SELECT id, provider_id AS providerId/.test(sql)) return [[{ id: ASSIGNMENT, providerId: PROVIDER, status: 'active' }], []];
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
    if (req.headers.authorization === 'Bearer admin') req.user = { id: USER, username: 'admin', role: 'admin' };
    else if (req.headers.authorization === 'Bearer provider') req.user = { id: USER, username: 'provider', role: 'provider_admin' };
    next();
  };
  app.use('/platform', createRouter(database, { authenticate }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('la console richieste rifiuta ruoli diversi dagli amministratori piattaforma', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/platform/inquiries', { headers: { authorization: 'Bearer provider' } });
    assert.equal(response.status, 403);
  });
});

test('l’assegnazione salva active_inquiry_id e registra l’operazione', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/platform/inquiries/' + INQUIRY + '/assign', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER, reason: 'Impresa verificata selezionata per il comune richiesto.' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.providerId, PROVIDER);
    const insert = database.calls.find(call => call.kind === 'execute' && /INSERT INTO inquiry_provider_assignments/.test(call.sql));
    assert.match(insert.sql, /active_inquiry_id/);
    assert.equal(insert.values[0], INQUIRY);
    assert.equal(insert.values[3], INQUIRY);
    assert.ok(database.calls.some(call => call.kind === 'execute' && /INSERT INTO audit_log/.test(call.sql)));
  });
});

test('la chiusura revoca l’assegnazione e libera active_inquiry_id', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const assigned = await fetch(base + '/platform/inquiries/' + INQUIRY + '/assign', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER, reason: 'Impresa verificata selezionata per il comune richiesto.' })
    });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    const response = await fetch(base + '/platform/inquiries/' + INQUIRY + '/status', {
      method: 'PATCH', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed', reason: 'La richiesta viene chiusa dopo la gestione concordata.' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    const revoke = database.calls.find(call => call.kind === 'execute' && /UPDATE inquiry_provider_assignments/.test(call.sql));
    assert.match(revoke.sql, /active_inquiry_id = NULL/);
    assert.equal(revoke.values[2], INQUIRY);
  });
});
