'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createRouter = require('../provider-portal-invitation-routes');

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; }
  };
}
function handler(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, 'missing route ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
function makeClient(queryImpl) {
  const calls = [];
  return {
    calls,
    async query(sql, args = []) {
      calls.push({ sql, args });
      return queryImpl(sql, args);
    },
    release() {}
  };
}
const token = 'provider-invite-' + 'x'.repeat(40);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('provider invitation routes require authentication middleware', () => {
  assert.throws(() => createRouter({ pool: { query() {}, connect() {} } }), /Authentication middleware/);
});

test('platform bootstrap invitation requires a platform administrator and valid provider UUID', async () => {
  let connected = false;
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => { connected = true; } },
    authenticate: (_req, _res, next) => next(),
    sendInvitationEmail: async () => true,
    publicAppUrl: 'https://example.test'
  });
  const invoke = handler(router, '/providers/:providerId/invitations', 'post');
  const denied = response();
  await invoke({ user: { id: 'u1', role: 'operator' }, params: { providerId: 'bad' }, body: {} }, denied, e => { throw e; });
  assert.equal(denied.statusCode, 403);
  const invalid = response();
  await invoke({ user: { id: 'u1', role: 'admin' }, params: { providerId: 'bad' }, body: {} }, invalid, e => { throw e; });
  assert.equal(invalid.statusCode, 400);
  assert.equal(connected, false);
});

test('invitation creation stores only a token hash and emails the raw token over HTTPS', async () => {
  const calls = [];
  let email;
  const client = makeClient((sql, args) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ name: 'Impresa Alfa' }] };
    if (sql.includes('FROM provider_user_access')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO provider_user_invitations')) {
      assert.equal(args[0], '11111111-1111-4111-8111-111111111111');
      assert.equal(args[1], 'persona@example.com');
      assert.equal(args[2], 'provider_operator');
      assert.equal(args[3].length, 64);
      assert.notEqual(args[3], token);
      assert.equal(args[4], 'admin-user');
      return { rowCount: 1, rows: [{ id: 'invite-1' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async (sql, args) => { calls.push({ sql, args }); return { rowCount: 1, rows: [] }; }, connect: async () => client },
    authenticate: (_req, _res, next) => next(),
    sendInvitationEmail: async payload => { email = payload; },
    publicAppUrl: 'https://portal.example.test'
  });
  const res = response();
  await handler(router, '/providers/:providerId/invitations', 'post')({
    user: { id: 'admin-user', role: 'platform_owner' },
    params: { providerId: '11111111-1111-4111-8111-111111111111' },
    body: { email: ' Persona@Example.com ', role: 'provider_operator' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.email, 'persona@example.com');
  assert.equal(email.to, 'persona@example.com');
  assert.equal(email.businessName, 'Impresa Alfa');
  assert.equal(email.invitationUrl.startsWith('https://portal.example.test/provider/invito/accetta?token='), true);
  const raw = new URL(email.invitationUrl).searchParams.get('token');
  const insert = client.calls.find(call => call.sql.includes('INSERT INTO provider_user_invitations'));
  assert.equal(insert.args[3], digest(raw));
  assert.equal(res.body.data.invitationId, 'invite-1');
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('provider invitations are disabled without an email sender or HTTPS base URL', async () => {
  let connected = false;
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => { connected = true; } },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/providers/:providerId/invitations', 'post')({
    user: { id: 'admin-user', role: 'admin' },
    params: { providerId: '11111111-1111-4111-8111-111111111111' },
    body: { email: 'person@example.com', role: 'provider_admin' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.equal(connected, false);
});

test('failed delivery revokes the invitation and never returns the raw token', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ name: 'Impresa Alfa' }] };
    if (sql.includes('FROM provider_user_access') || sql.includes('FROM provider_user_invitations')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO provider_user_invitations')) return { rowCount: 1, rows: [{ id: 'invite-failed' }] };
    return { rowCount: 1, rows: [] };
  });
  let revokeArgs;
  const router = createRouter({
    pool: { query: async (sql, args) => { revokeArgs = { sql, args }; return { rowCount: 1, rows: [] }; }, connect: async () => client },
    authenticate: (_req, _res, next) => next(),
    sendInvitationEmail: async () => { throw new Error('mail offline'); },
    publicAppUrl: 'https://portal.example.test'
  });
  const res = response();
  await handler(router, '/providers/:providerId/invitations', 'post')({
    user: { id: 'admin-user', role: 'admin' },
    params: { providerId: '11111111-1111-4111-8111-111111111111' },
    body: { email: 'person@example.com', role: 'provider_admin' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.match(revokeArgs.sql, /status = 'revoked'/);
  assert.equal(JSON.stringify(res.body).includes(token), false);
});

test('acceptance requires the invited email to be verified on the authenticated account', async () => {
  const calls = [];
  const client = makeClient((sql, args) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
      id: 'invite-1', providerId: 'provider-alpha', email: 'invited@example.com',
      role: 'provider_admin', status: 'pending', expiresAt: new Date(Date.now() + 60000),
      invitedByUserId: 'admin-user'
    }] };
    if (sql.includes('FROM app_users')) return { rowCount: 1, rows: [{
      id: 'user-1', email: 'different@example.com', emailVerifiedAt: new Date(), active: true
    }] };
    return { rowCount: 0, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/accept', 'post')({
    user: { id: 'user-1' }, body: { token }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 403);
  assert.equal(client.calls.some(call => call.sql.includes('INSERT INTO provider_user_access')), false);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
  const lookup = client.calls.find(call => call.sql.includes('FROM provider_user_invitations'));
  assert.equal(lookup.args[0], digest(token));
});

test('acceptance activates access only for the invited provider and writes an audit record atomically', async () => {
  const client = makeClient((sql, args = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
      id: 'invite-1', providerId: 'provider-alpha', email: 'invited@example.com',
      role: 'provider_operator', status: 'pending', expiresAt: new Date(Date.now() + 60000),
      invitedByUserId: 'admin-user'
    }] };
    if (sql.includes('FROM app_users')) return { rowCount: 1, rows: [{
      id: 'user-1', email: 'INVITED@example.com', emailVerifiedAt: new Date(), active: true
    }] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-alpha' }] };
    if (sql.includes('FROM provider_user_access')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO provider_user_access')) {
      assert.deepEqual(args, ['provider-alpha', 'user-1', 'provider_operator', 'admin-user']);
      return { rowCount: 1, rows: [{ id: 'access-1' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/accept', 'post')({
    user: { id: 'user-1' }, body: { token }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.providerId, 'provider-alpha');
  assert.equal(res.body.data.role, 'provider_operator');
  assert.equal(client.calls.some(call => call.sql.includes('INSERT INTO provider_portal_audit_log')), true);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('expired invitation is marked expired and cannot create provider access', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
      id: 'invite-old', providerId: 'provider-alpha', email: 'invited@example.com',
      role: 'provider_operator', status: 'pending', expiresAt: new Date(Date.now() - 1000),
      invitedByUserId: 'admin-user'
    }] };
    return { rowCount: 0, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/accept', 'post')({
    user: { id: 'user-1' }, body: { token }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 410);
  assert.equal(client.calls.some(call => call.sql.includes("SET status = 'expired'")), true);
  assert.equal(client.calls.some(call => call.sql.includes('INSERT INTO provider_user_access')), false);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('provider operators cannot invite colleagues through their provider context', async () => {
  const router = createRouter({
    pool: { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => { throw new Error('must not connect'); } },
    authenticate: (_req, _res, next) => next(),
    sendInvitationEmail: async () => true,
    publicAppUrl: 'https://portal.example.test'
  });
  const route = router.stack.find(item => item.route?.path === '/invitations' && item.route.methods.post);
  assert.ok(route);
  const invoke = route.route.stack.at(-1).handle;
  const res = response();
  await invoke({ provider: { role: 'provider_operator', providerId: 'provider-alpha' }, user: { id: 'u1' }, body: {} }, res, e => { throw e; });
  assert.equal(res.statusCode, 403);
});
