'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createTenantInvitationRouter = require('../tenant-invitation-routes');
const { createResendInvitationSender } = require('../resend-email');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function postHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, 'missing POST ' + path);
  return layer.route.stack.at(-1).handle;
}

const tenant = {
  companyId: '11111111-1111-4111-8111-111111111111',
  membershipId: '22222222-2222-4222-8222-222222222222',
  role: 'admin'
};

function invitationPool({ sendFails = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('SELECT legal_name AS name FROM companies')) {
        return { rowCount: 1, rows: [{ name: 'Impresa di prova' }] };
      }
      if (sql.includes('SELECT id FROM company_memberships')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO company_invitations')) {
        return { rowCount: 1, rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() { calls.push({ released: true }); }
  };
  const pool = {
    calls,
    async connect() { return client; },
    async query(sql, args) {
      calls.push({ sql, args, poolQuery: true });
      if (sendFails && sql.includes("UPDATE company_invitations SET status = 'revoked'")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected pool SQL: ' + sql);
    }
  };
  return pool;
}

test('tenant invitation route sends through the Resend adapter and stores only the token digest', async () => {
  const pool = invitationPool();
  let outgoing;
  const sendInvitationEmail = createResendInvitationSender({
    apiKey: 'test-only-secret',
    from: 'FUNERAL SMART <onboarding@resend.dev>',
    fetchImpl: async (url, options) => {
      outgoing = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'email_test_456' }) };
    }
  });
  const router = createTenantInvitationRouter({
    pool,
    sendInvitationEmail,
    publicAppUrl: 'https://funeral-smart.example'
  });
  const res = response();

  await postHandler(router, '/company/invitations')({
    tenant,
    body: { email: 'COLLEGA@example.com', role: 'operator' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.status, 'pending');
  assert.equal(outgoing.url, 'https://api.resend.com/emails');
  const email = JSON.parse(outgoing.options.body);
  assert.deepEqual(email.to, ['collega@example.com']);
  assert.match(email.html, /Impresa di prova/);
  assert.match(email.text, /https:\/\/funeral-smart\.example\/invito\/accetta\?token=/);

  const insert = pool.calls.find(call => call.sql?.includes('INSERT INTO company_invitations'));
  assert.ok(insert);
  assert.equal(insert.args[0], tenant.companyId);
  assert.equal(insert.args[1], 'collega@example.com');
  assert.match(insert.args[3], /^[a-f0-9]{64}$/);
  assert.equal(insert.args[4], tenant.membershipId);
  assert.ok(!email.text.includes(insert.args[3]));
});

test('failed Resend delivery revokes the pending invitation and returns no success', async () => {
  const pool = invitationPool({ sendFails: true });
  const sendInvitationEmail = createResendInvitationSender({
    apiKey: 'test-only-secret',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'private provider detail' })
    })
  });
  const router = createTenantInvitationRouter({
    pool,
    sendInvitationEmail,
    publicAppUrl: 'https://funeral-smart.example'
  });
  const res = response();

  await postHandler(router, '/company/invitations')({
    tenant,
    body: { email: 'collega@example.com', role: 'operator' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /non consegnato/i);
  assert.doesNotMatch(JSON.stringify(res.body), /private provider detail|test-only-secret/);
  assert.ok(pool.calls.some(call => call.poolQuery && call.sql.includes("SET status = 'revoked'")));
});
