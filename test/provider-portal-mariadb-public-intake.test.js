'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const rateLimit = require('express-rate-limit');
const createRouter = require('../provider-portal-mariadb/public-intake-routes');

async function withServer(database, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(database, {
    submissionLimiter: rateLimit({ windowMs: 60000, limit: 10, standardHeaders: false, legacyHeaders: false })
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function makeDatabase() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT id, created_at AS createdAt FROM inquiries/.test(sql)) {
        return [[{ id: values[0], createdAt: '2026-11-27 12:00:00.000' }], []];
      }
      if (/SELECT id, created_at AS createdAt FROM provider_applications/.test(sql)) {
        return [[{ id: values[0], createdAt: '2026-11-27 12:00:00.000' }], []];
      }
      if (/INSERT INTO/.test(sql)) return [{ affectedRows: 1 }, []];
      return [[], []];
    }
  };
}

test('la richiesta famiglia accetta Cremazione + Sepoltura e non la assegna automaticamente', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/api/v1/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        city: 'Torino', serviceType: 'Cremazione + Sepoltura',
        contactPhone: '+390110000000', privacyConsent: true
      })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.ok(body.data.id);
    assert.match(body.message, /Non è ancora stata inoltrata/);
    const insert = database.calls.find(call => /INSERT INTO inquiries/.test(call.sql));
    assert.equal(insert.values[2], 'Cremazione + Sepoltura');
    assert.match(insert.sql, /'received'/);
  });
});

test('la richiesta famiglia richiede recapito e consenso privacy', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/api/v1/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ city: 'Torino', serviceType: 'Sepoltura', privacyConsent: false })
    });
    assert.equal(response.status, 400);
    assert.equal(database.calls.length, 0);
  });
});

test('le candidature impresa restano pending e non pubbliche', async () => {
  const database = makeDatabase();
  await withServer(database, async base => {
    const response = await fetch(base + '/api/v1/provider-applications', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Impresa Demo Torino', vatNumber: 'IT12345678901',
        city: 'Torino', email: 'demo@example.test', acceptsVerification: true
      })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.match(body.message, /non è ancora pubblicata né verificata/);
    const insert = database.calls.find(call => /INSERT INTO provider_applications/.test(call.sql));
    assert.match(insert.sql, /'pending'/);
  });
});
