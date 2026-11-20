'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const createRouter = require('../provider-portal-mariadb/invitation-routes');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const ACCESS = '33333333-3333-4333-8333-333333333333';
const INVITATION = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'a'.repeat(43);

function makeDatabase({ role = 'provider_admin', userRows = [], activeAdmins = 1, invitationRows = [{ id: INVITATION, providerId: PROVIDER, email: 'collaboratore@example.com', role: 'provider_operator', status: 'pending', expiresAt: '2099-01-01 00:00:00.000', isExpired: 0, invitedByUserId: USER }] } = {}) {
  const calls = [];
  const database = {
    calls,
    async query(sql, values = []) {
      calls.push({ type: 'query', sql, values });
      if (/FROM provider_user_access/.test(sql)) return [[{ providerId: PROVIDER, role, businessName: 'Impresa Test' }], []];
      return [[], []];
    },
    async withTransaction(work) {
      const connection = {
        async execute(sql, values = []) {
          calls.push({ type: 'execute', sql, values });
          if (/SELECT business_name/.test(sql)) return [[{ businessName: 'Impresa Test' }], []];
          if (/FROM provider_user_invitations WHERE token_hash/.test(sql)) return [invitationRows, []];
          if (/SELECT access\.id/.test(sql)) return [[], []];
          if (/SELECT id FROM provider_user_invitations/.test(sql)) return [[{ id: INVITATION }], []];
          if (/SELECT id, email, email_verified_at/.test(sql)) return [userRows, []];
          if (/SELECT COUNT\(\*\) AS activeAdmins/.test(sql)) return [[{ activeAdmins }], []];
          if (/SELECT a\.id, a\.role, a\.status/.test(sql)) return [[{ id: ACCESS, role: 'provider_admin', status: 'active', accountActive: 1 }], []];
          if (/SELECT id, role, status FROM provider_user_access/.test(sql)) return [[{ id: ACCESS, role: 'provider_admin', status: 'active' }], []];
          if (/SELECT id FROM providers/.test(sql)) return [[{ id: PROVIDER }], []];
          return [{ affectedRows: 1 }, []];
        }
      };
      return work(connection);
    }
  };
  return database;
}

async function withServer(database, options, fn, user = { id: USER, role: 'user' }) {
  const app = express();
  app.use(express.json());
  const authenticate = (req, _res, next) => { req.user = user; next(); };
  app.use('/portal', createRouter(database, { authenticate, ...options }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('router richiede adapter transazionale e middleware di autenticazione', () => {
  assert.throws(() => createRouter({ query() {} }), /withTransaction/);
  assert.throws(() => createRouter({ query() {}, withTransaction() {} }), /Authentication/);
});

test('un operatore non può consultare o gestire gli inviti', async () => {
  const database = makeDatabase({ role: 'provider_operator' });
  await withServer(database, {}, async base => {
    const response = await fetch(base + '/portal/invitations');
    assert.equal(response.status, 403);
  });
});

test('creazione invito salva solo hash token e richiede URL HTTPS', async () => {
  const database = makeDatabase();
  let delivered;
  await withServer(database, {
    publicAppUrl: 'https://funeralsmartapp.com',
    sendInvitationEmail: async message => { delivered = message; }
  }, async base => {
    const response = await fetch(base + '/portal/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ' Collaboratore@Example.com ', role: 'provider_operator' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.email, 'collaboratore@example.com');
    assert.equal(delivered.to, 'collaboratore@example.com');
    assert.match(delivered.invitationUrl, /^https:\/\/funeralsmartapp\.com\//);
    const insert = database.calls.find(call => call.type === 'execute' && /INSERT INTO provider_user_invitations/.test(call.sql));
    assert.ok(insert);
    assert.equal(insert.values[1], 'collaboratore@example.com');
    assert.equal(insert.values[3].length, 64);
    assert.doesNotMatch(insert.values[3], /a{20}/);
  });
});

test('accettazione rifiuta account senza email verificata prima di creare accessi', async () => {
  const database = makeDatabase({ userRows: [{ id: USER, email: 'collaboratore@example.com', emailVerifiedAt: null, active: 1 }] });
  await withServer(database, {}, async base => {
    const response = await fetch(base + '/portal/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN })
    });
    assert.equal(response.status, 403);
    assert.equal(database.calls.some(call => call.type === 'execute' && /INSERT INTO provider_user_access/.test(call.sql)), false);
  });
});

test('non consente di sospendere l’ultimo amministratore attivo', async () => {
  const database = makeDatabase({ activeAdmins: 1 });
  await withServer(database, {}, async base => {
    const response = await fetch(base + '/portal/members/' + ACCESS + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' })
    });
    assert.equal(response.status, 409);
    assert.equal(database.calls.some(call => call.type === 'execute' && /UPDATE provider_user_access SET status/.test(call.sql)), false);
  });
});
