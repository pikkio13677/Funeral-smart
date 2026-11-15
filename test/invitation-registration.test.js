'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createAuth = require('../auth');

function response() {
  return {
    statusCode: 200, body: null, cookies: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); }
  };
}

function postHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, 'missing POST ' + path);
  return layer.route.stack.at(-1).handle;
}

test('invitation registration stays disabled unless both staging flags are explicitly enabled', async () => {
  let connected = false;
  const router = createAuth({ connect: async () => { connected = true; } }, {
    emailVerificationEnabled: true,
    invitationRegistrationEnabled: false
  }).router;
  const res = response();
  await postHandler(router, '/invitation/register')({ body: {} }, res, error => { throw error; });
  assert.equal(res.statusCode, 404);
  assert.equal(connected, false);
});

test('invitation registration creates an unverified least-privilege account and a session atomically', async () => {
  const rawToken = 'i'.repeat(48);
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations')) return {
        rowCount: 1,
        rows: [{ id: 'invite-1', email: 'new.member@example.com', status: 'pending', expiresAt: new Date(Date.now() + 60000) }]
      };
      if (sql.includes('FROM app_users')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO app_users')) return {
        rowCount: 1,
        rows: [{ id: 'user-1', username: 'new.member', displayName: 'Nuovo membro', email: 'new.member@example.com' }]
      };
      if (sql.includes('INSERT INTO app_sessions')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() { calls.push({ sql: 'RELEASE', args: [] }); }
  };
  const pool = { connect: async () => client };
  const router = createAuth(pool, {
    emailVerificationEnabled: true,
    invitationRegistrationEnabled: true
  }).router;
  const res = response();
  await postHandler(router, '/invitation/register')({
    body: {
      token: rawToken,
      username: 'New.Member',
      displayName: 'Nuovo membro',
      password: 'correct horse battery'
    },
    ip: '127.0.0.1'
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.email, 'new.member@example.com');
  assert.equal(res.body.data.emailVerifiedAt, null);
  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].name, 'fs_session');
  assert.equal(calls.at(-2).sql, 'COMMIT');
  const invitationLookup = calls.find(call => call.sql.includes('FROM company_invitations'));
  const expectedTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  assert.equal(invitationLookup.args[0], expectedTokenHash);
  const insert = calls.find(call => call.sql.includes('INSERT INTO app_users'));
  assert.equal(insert.args[0], 'new.member');
  assert.equal(insert.args[3], 'new.member@example.com');
  assert.match(insert.args[2], /^scrypt\$/);
  assert.notEqual(insert.args[2], 'correct horse battery');
  assert.match(insert.sql, /'operator'/);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO app_sessions')));
  assert.ok(calls.some(call => call.sql.includes('auth.invitation_registered')));
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO company_memberships')), false);
});

test('invitation registration refuses an expired invitation before creating an account', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations')) return {
        rowCount: 1,
        rows: [{ id: 'invite-1', email: 'new.member@example.com', status: 'pending', expiresAt: new Date(Date.now() - 60000) }]
      };
      if (sql.includes("SET status='expired'")) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  const router = createAuth({ connect: async () => client }, {
    emailVerificationEnabled: true,
    invitationRegistrationEnabled: true
  }).router;
  const res = response();
  await postHandler(router, '/invitation/register')({
    body: { token: 'i'.repeat(48), username: 'new.member', displayName: 'Nuovo membro', password: 'correct horse battery' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 410);
  assert.ok(calls.some(sql => sql.includes("SET status='expired'")));
  assert.equal(calls.some(sql => sql.includes('INSERT INTO app_users')), false);
});

test('invitation registration rejects malformed credentials before database access', async () => {
  let connected = false;
  const router = createAuth({ connect: async () => { connected = true; } }, {
    emailVerificationEnabled: true,
    invitationRegistrationEnabled: true
  }).router;
  const res = response();
  await postHandler(router, '/invitation/register')({
    body: { token: 'short', username: 'x', displayName: 'A', password: 'weak' }
  }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});
