'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../provider-portal-mariadb');

const PROVIDER = '22222222-2222-4222-8222-222222222222';

function makeDatabase() {
  return {
    async query() { return [[], []]; },
    async withTransaction(work) {
      return work({
        async execute() { return [[], []]; }
      });
    }
  };
}

async function withServer(user, fn) {
  const app = express();
  app.use(express.json());
  const authenticate = (req, _res, next) => { req.user = user; next(); };
  app.use('/api/v1/provider-portal', createRouter(makeDatabase(), { authenticate }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('router composto richiede adapter transazionale e autenticazione', () => {
  assert.throws(() => createRouter({ query() {} }), /withTransaction/);
  assert.throws(() => createRouter({ query() {}, withTransaction() {} }), /Authentication/);
});

test('endpoint di accettazione invito è montato senza richiedere prima un contesto impresa', async () => {
  await withServer({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, async base => {
    const response = await fetch(base + '/api/v1/provider-portal/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /invito|token/i);
  });
});

test('attivazione primo accesso impresa è instradata al router inviti per il controllo admin piattaforma', async () => {
  await withServer({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'user' }, async base => {
    const response = await fetch(base + '/api/v1/provider-portal/providers/' + PROVIDER + '/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', role: 'provider_admin' })
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.match(body.error, /amministratore della piattaforma/i);
  });
});
