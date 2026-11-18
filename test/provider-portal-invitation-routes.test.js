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


test('provider administrators can list only their provider invitations without token material', async () => {
  let query;
  const router = createRouter({
    pool: {
      query: async (sql, args) => {
        query = { sql, args };
        return { rowCount: 1, rows: [{ id: 'invite-1', email: 'person@example.com', role: 'provider_operator', status: 'pending' }] };
      },
      connect: async () => { throw new Error('GET must not open a transaction'); }
    },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations', 'get')({
    provider: { providerId: 'provider-alpha', role: 'provider_admin' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(query.args, ['provider-alpha']);
  assert.match(query.sql, /WHERE provider_id = \$1/);
  assert.match(query.sql, /CASE WHEN status = 'pending'/);
  assert.doesNotMatch(query.sql, /token_hash/);
  assert.equal(res.body.data[0].email, 'person@example.com');
});

test('provider operators cannot list or revoke invitations', async () => {
  const router = createRouter({
    pool: { query: async () => { throw new Error('must not query'); }, connect: async () => { throw new Error('must not connect'); } },
    authenticate: (_req, _res, next) => next()
  });
  const list = response();
  await handler(router, '/invitations', 'get')({
    provider: { providerId: 'provider-alpha', role: 'provider_operator' }
  }, list, error => { throw error; });
  assert.equal(list.statusCode, 403);
  const revoke = response();
  await handler(router, '/invitations/:invitationId', 'delete')({
    provider: { providerId: 'provider-alpha', role: 'provider_operator' },
    params: { invitationId: '11111111-1111-4111-8111-111111111111' }
  }, revoke, error => { throw error; });
  assert.equal(revoke.statusCode, 403);
});

test('provider administrator revocation is provider-scoped and audited in the same transaction', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60000)
    }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/:invitationId', 'delete')({
    user: { id: 'provider-admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { invitationId: '11111111-1111-4111-8111-111111111111' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'revoked');
  assert.equal(client.calls.some(call => call.sql.includes("SET status = 'revoked', revoked_at = NOW()") && call.args[1] === 'provider-alpha'), true);
  assert.equal(client.calls.some(call => call.sql.includes('provider.invitation.revoked') && call.args[1] === 'provider-admin-user'), true);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), false);
});

test('provider administrator cannot revoke an invitation belonging to another provider', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/:invitationId', 'delete')({
    user: { id: 'provider-admin-user' },
    provider: { providerId: 'provider-beta', role: 'provider_admin' },
    params: { invitationId: '11111111-1111-4111-8111-111111111111' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 404);
  assert.equal(client.calls.some(call => call.sql.includes('provider.invitation.revoked')), false);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('expired invitation cannot be revoked and is marked expired instead', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000)
    }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/invitations/:invitationId', 'delete')({
    user: { id: 'provider-admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { invitationId: '11111111-1111-4111-8111-111111111111' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 410);
  assert.equal(client.calls.some(call => call.sql.includes("SET status = 'expired'")), true);
  assert.equal(client.calls.some(call => call.sql.includes('provider.invitation.revoked')), false);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('accepted or already revoked invitations cannot be revoked again', async () => {
  for (const status of ['accepted', 'revoked']) {
    const client = makeClient(sql => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM provider_user_invitations')) return { rowCount: 1, rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        status,
        expiresAt: new Date(Date.now() + 60000)
      }] };
      return { rowCount: 1, rows: [] };
    });
    const router = createRouter({
      pool: { query: async () => ({}), connect: async () => client },
      authenticate: (_req, _res, next) => next()
    });
    const res = response();
    await handler(router, '/invitations/:invitationId', 'delete')({
      user: { id: 'provider-admin-user' },
      provider: { providerId: 'provider-alpha', role: 'provider_admin' },
      params: { invitationId: '11111111-1111-4111-8111-111111111111' }
    }, res, error => { throw error; });
    assert.equal(res.statusCode, 409);
    assert.equal(client.calls.some(call => call.sql.includes("SET status = 'revoked'")), false);
    assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
  }
});


test('provider administrators can list only active and suspended members of their provider', async () => {
  let query;
  const router = createRouter({
    pool: {
      query: async (sql, args) => {
        query = { sql, args };
        return { rowCount: 1, rows: [{ accessId: 'member-1', username: 'collega', displayName: 'Collaboratore', role: 'provider_operator', status: 'active' }] };
      },
      connect: async () => { throw new Error('GET must not open a transaction'); }
    },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members', 'get')({
    provider: { providerId: 'provider-alpha', role: 'provider_admin' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(query.args, ['provider-alpha']);
  assert.match(query.sql, /access\.provider_id = \$1/);
  assert.match(query.sql, /access\.status IN \('active', 'suspended'\)/);
  assert.doesNotMatch(query.sql, /token_hash|password_hash|totp_secret/);
});

test('provider operators cannot list or change provider members', async () => {
  const router = createRouter({
    pool: { query: async () => { throw new Error('must not query'); }, connect: async () => { throw new Error('must not connect'); } },
    authenticate: (_req, _res, next) => next()
  });
  const list = response();
  await handler(router, '/members', 'get')({
    provider: { providerId: 'provider-alpha', role: 'provider_operator' }
  }, list, error => { throw error; });
  assert.equal(list.statusCode, 403);
  const update = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    provider: { providerId: 'provider-alpha', role: 'provider_operator' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'suspended' }
  }, update, error => { throw error; });
  assert.equal(update.statusCode, 403);
});

test('member status endpoint rejects invalid UUID and invalid status without opening a transaction', async () => {
  let connects = 0;
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => { connects++; throw new Error('must not connect'); } },
    authenticate: (_req, _res, next) => next()
  });
  const invoke = handler(router, '/members/:accessId/status', 'patch');
  const invalidId = response();
  await invoke({ provider: { providerId: 'provider-alpha', role: 'provider_admin' }, params: { accessId: 'bad' }, body: { status: 'suspended' } }, invalidId, error => { throw error; });
  assert.equal(invalidId.statusCode, 400);
  const invalidStatus = response();
  await invoke({ provider: { providerId: 'provider-alpha', role: 'provider_admin' }, params: { accessId: '11111111-1111-4111-8111-111111111111' }, body: { status: 'revoked' } }, invalidStatus, error => { throw error; });
  assert.equal(invalidStatus.statusCode, 400);
  assert.equal(connects, 0);
});

test('provider administrator can suspend a colleague with atomic audit', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-alpha' }] };
    if (sql.includes('FROM provider_user_access access JOIN app_users')) return { rowCount: 1, rows: [{
      id: 'member-1', userId: 'operator-user', role: 'provider_operator', status: 'active', accountActive: true
    }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    user: { id: 'admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'suspended' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'suspended');
  assert.equal(client.calls.some(call => call.sql.includes('FOR UPDATE')), true);
  assert.equal(client.calls.some(call => call.args?.includes('provider.member.suspended')), true);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('last active provider administrator cannot be suspended', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-alpha' }] };
    if (sql.includes('FROM provider_user_access access JOIN app_users')) return { rowCount: 1, rows: [{
      id: 'admin-access', userId: 'admin-user', role: 'provider_admin', status: 'active', accountActive: true
    }] };
    if (sql.includes('SELECT COUNT(*)::int AS active_admins')) return { rowCount: 1, rows: [{ active_admins: 1 }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    user: { id: 'admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'suspended' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /ultimo amministratore attivo/);
  assert.equal(client.calls.some(call => call.sql.includes('UPDATE provider_user_access SET status')), false);
  assert.equal(client.calls.some(call => call.sql.includes('provider.member.suspended')), false);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('suspending an administrator is allowed when another active administrator remains', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-alpha' }] };
    if (sql.includes('FROM provider_user_access access JOIN app_users')) return { rowCount: 1, rows: [{
      id: 'admin-access', userId: 'admin-user', role: 'provider_admin', status: 'active', accountActive: true
    }] };
    if (sql.includes('SELECT COUNT(*)::int AS active_admins')) return { rowCount: 1, rows: [{ active_admins: 2 }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    user: { id: 'admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'suspended' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'suspended');
  assert.equal(client.calls.some(call => call.sql.includes('SELECT COUNT(*)::int AS active_admins')), true);
});

test('suspended member can be reactivated, but platform-disabled accounts stay blocked', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-alpha' }] };
    if (sql.includes('FROM provider_user_access access JOIN app_users')) return { rowCount: 1, rows: [{
      id: 'member-1', userId: 'operator-user', role: 'provider_operator', status: 'suspended', accountActive: true
    }] };
    return { rowCount: 1, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    user: { id: 'admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'active' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'active');
  assert.equal(client.calls.some(call => call.args?.includes('provider.member.reactivated')), true);
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
});

test('provider administrator cannot modify a membership belonging to another provider', async () => {
  const client = makeClient(sql => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM providers')) return { rowCount: 1, rows: [{ id: 'provider-beta' }] };
    if (sql.includes('FROM provider_user_access access JOIN app_users')) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  });
  const router = createRouter({
    pool: { query: async () => ({}), connect: async () => client },
    authenticate: (_req, _res, next) => next()
  });
  const res = response();
  await handler(router, '/members/:accessId/status', 'patch')({
    user: { id: 'admin-user' },
    provider: { providerId: 'provider-alpha', role: 'provider_admin' },
    params: { accessId: '11111111-1111-4111-8111-111111111111' },
    body: { status: 'suspended' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 404);
  assert.equal(client.calls.some(call => call.sql.includes('provider.member.suspended')), false);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
});
