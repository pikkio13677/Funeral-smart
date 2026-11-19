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
  app.use(express.json());
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
}], listRows = [], detailRows = [], auditRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('FROM provider_portal_audit_log')) return { rowCount: auditRows.length, rows: auditRows };
      if (sql.includes('FROM provider_user_access')) {
        return { rowCount: accessRows.length, rows: accessRows };
      }
      if (sql.includes('assignment.id = $1')) return { rowCount: detailRows.length, rows: detailRows };
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


function transactionalPool({ assignmentVisible = true, auditFails = false } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, args) {
      calls.push({ sql, args, channel: 'pool' });
      if (sql.includes('FROM provider_user_access')) {
        return { rowCount: 1, rows: [{
          providerId: PROVIDER_ID,
          role: 'provider_admin',
          businessName: 'Impresa Alfa'
        }] };
      }
      throw new Error('Unexpected pool SQL: ' + sql);
    },
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args, channel: 'client' });
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM inquiry_provider_assignments')) {
            return assignmentVisible
              ? { rowCount: 1, rows: [{ id: '44444444-4444-4444-8444-444444444444', providerId: PROVIDER_ID, inquiryStatus: 'assigned' }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM provider_inquiry_responses')) return { rowCount: 0, rows: [] };
          if (sql.includes('INSERT INTO provider_inquiry_responses')) {
            return { rowCount: 1, rows: [{
              id: '55555555-5555-4555-8555-555555555555',
              assignmentId: args[0],
              status: args[2],
              respondedAt: '2026-11-18T20:00:00.000Z'
            }] };
          }
          if (sql.includes('INSERT INTO provider_portal_audit_log')) {
            if (auditFails) throw new Error('simulated audit failure');
            return { rowCount: 1, rows: [] };
          }
          throw new Error('Unexpected client SQL: ' + sql);
        },
        release() { calls.push({ sql: 'RELEASE', channel: 'client' }); }
      };
    }
  };
  return pool;
}

test('provider can accept an active assignment and response plus audit commit atomically', async () => {
  const pool = transactionalPool();
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries/44444444-4444-4444-8444-444444444444/response', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-test-user', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'accepted', reason: 'Possiamo prendere in carico il servizio.' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.status, 'accepted');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(body).includes('contact_email'), false);
    const statements = pool.calls.filter(call => call.channel === 'client').map(call => call.sql);
    assert.equal(statements[0], 'BEGIN');
    assert.ok(statements.some(sql => sql.includes('assignment.provider_id = $2')));
    assert.ok(statements.some(sql => sql.includes('INSERT INTO provider_inquiry_responses')));
    assert.ok(statements.some(sql => sql.includes('INSERT INTO provider_portal_audit_log')));
    assert.ok(statements.includes('COMMIT'));
    assert.equal(statements.at(-1), 'RELEASE');
    const responseInsert = pool.calls.find(call => call.sql.includes('INSERT INTO provider_inquiry_responses'));
    assert.deepEqual(responseInsert.args, [
      '44444444-4444-4444-8444-444444444444',
      PROVIDER_ID,
      'accepted',
      'Possiamo prendere in carico il servizio.',
      USER_ID
    ]);
  });
});

test('provider cannot respond to another provider assignment', async () => {
  const pool = transactionalPool({ assignmentVisible: false });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries/44444444-4444-4444-8444-444444444444/response', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-test-user', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', reason: 'Non possiamo svolgere il servizio richiesto.' })
    });
    assert.equal(response.status, 404);
    const statements = pool.calls.filter(call => call.channel === 'client').map(call => call.sql);
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(statements.some(sql => sql.includes('INSERT INTO provider_inquiry_responses')), false);
  });
});

test('audit failure rolls back provider acceptance', async () => {
  const pool = transactionalPool({ auditFails: true });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries/44444444-4444-4444-8444-444444444444/response', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-test-user', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'accepted', reason: 'Accettiamo la richiesta del servizio.' })
    });
    assert.equal(response.status, 500);
    const statements = pool.calls.filter(call => call.channel === 'client').map(call => call.sql);
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(statements.includes('COMMIT'), false);
  });
});


test('provider inquiry detail hides family contacts until the assignment is accepted', async () => {
  const assignmentId = '44444444-4444-4444-8444-444444444444';
  const pool = fakePool({ detailRows: [{
    assignmentId,
    city: 'Torino',
    serviceType: 'burial',
    destinationCountry: null,
    responseStatus: null,
    contactEmail: null,
    contactPhone: null
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries/' + assignmentId, {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.contactEmail, null);
    assert.equal(body.data.contactPhone, null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const query = pool.calls.find(call => call.sql.includes('assignment.id = $1'));
    assert.deepEqual(query.args, [assignmentId, PROVIDER_ID]);
    assert.match(query.sql, /CASE WHEN response.status = 'accepted' THEN inquiry.contact_email ELSE NULL END/);
    assert.match(query.sql, /CASE WHEN response.status = 'accepted' THEN inquiry.contact_phone ELSE NULL END/);
    assert.doesNotMatch(query.sql, /inquiry\.notes|inquiry\.budget_euro/);
  });
});

test('provider inquiry detail returns contacts only after accepted response', async () => {
  const assignmentId = '44444444-4444-4444-8444-444444444444';
  const pool = fakePool({ detailRows: [{
    assignmentId,
    city: 'Torino',
    serviceType: 'burial',
    destinationCountry: null,
    responseStatus: 'accepted',
    contactEmail: 'family@example.invalid',
    contactPhone: '011000000'
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/inquiries/' + assignmentId, {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.responseStatus, 'accepted');
    assert.equal(body.data.contactEmail, 'family@example.invalid');
    assert.equal(body.data.contactPhone, '011000000');
    assert.equal(JSON.stringify(body).includes('notes'), false);
    assert.equal(JSON.stringify(body).includes('budget'), false);
  });
});


test('provider profile returns an explicit permission matrix for administrators', async () => {
  const pool = fakePool();
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.deepEqual(body.data.permissions, {
      viewInquiries: true,
      respondToInquiries: true,
      manageInvitations: true,
      manageMembers: true,
      manageMemberRoles: true,
      viewActivityLog: true
    });
  });
});

test('provider operators can view and respond to inquiries but cannot manage team', async () => {
  const pool = fakePool({ accessRows: [{
    providerId: PROVIDER_ID, role: 'provider_operator', businessName: 'Impresa Alfa'
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.deepEqual(body.data.permissions, {
      viewInquiries: true,
      respondToInquiries: true,
      manageInvitations: false,
      manageMembers: false,
      manageMemberRoles: false,
      viewActivityLog: false
    });
  });
});


test('provider administrators can read a provider-scoped activity timeline without free-text reasons', async () => {
  const pool = fakePool({ auditRows: [{
    id: '17',
    action: 'provider.member.suspended',
    createdAt: '2026-11-19T10:00:00.000Z',
    actorDisplayName: 'Admin Alfa',
    actorUsername: 'admin-alfa',
    city: null,
    serviceType: null
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/activity?limit=20&offset=5', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body.pagination, { limit: 20, offset: 5, returned: 1 });
    assert.equal(body.data[0].action, 'provider.member.suspended');
    assert.equal(body.data[0].actorDisplayName, 'Admin Alfa');
    assert.equal(JSON.stringify(body).includes('reason'), false);
    const query = pool.calls.find(call => call.sql.includes('FROM provider_portal_audit_log'));
    assert.deepEqual(query.args, [PROVIDER_ID, 20, 5]);
    assert.match(query.sql, /audit\.provider_id = \$1/);
    assert.match(query.sql, /ORDER BY audit\.created_at DESC, audit\.id DESC/);
    assert.match(query.sql, /LEFT JOIN app_users actor/);
    assert.match(query.sql, /LEFT JOIN inquiries inquiry/);
    assert.doesNotMatch(query.sql, /audit\.reason/);
  });
});

test('provider operators cannot read the activity timeline', async () => {
  const pool = fakePool({ accessRows: [{
    providerId: PROVIDER_ID,
    role: 'provider_operator',
    businessName: 'Impresa Alfa'
  }] });
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/activity', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    assert.equal(response.status, 403);
    assert.equal(pool.calls.some(call => call.sql.includes('FROM provider_portal_audit_log')), false);
  });
});

test('activity timeline rejects invalid pagination without querying the audit log', async () => {
  const pool = fakePool();
  await withServer(createProviderPortalRouter(pool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/activity?limit=500&unexpected=yes', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    assert.equal(response.status, 400);
    assert.equal(pool.calls.some(call => call.sql.includes('FROM provider_portal_audit_log')), false);
  });
});

test('provider profile grants activity-log permission only to administrators', async () => {
  const adminPool = fakePool();
  await withServer(createProviderPortalRouter(adminPool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(body.data.permissions.viewActivityLog, true);
  });
  const operatorPool = fakePool({ accessRows: [{
    providerId: PROVIDER_ID, role: 'provider_operator', businessName: 'Impresa Alfa'
  }] });
  await withServer(createProviderPortalRouter(operatorPool, { authenticate }), async base => {
    const response = await fetch(base + '/api/v1/provider-portal/me', {
      headers: { authorization: 'Bearer valid-test-user' }
    });
    const body = await response.json();
    assert.equal(body.data.permissions.viewActivityLog, false);
  });
});
