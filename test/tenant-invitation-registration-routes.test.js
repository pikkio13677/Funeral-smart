'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createRouter = require('../tenant-invitation-registration-routes');

function response() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
function handler(router) {
  const layer = router.stack.find(x => x.route?.path === '/invitation/register' && x.route.methods.post);
  assert.ok(layer, 'missing POST /invitation/register');
  return layer.route.stack.at(-1).handle;
}

test('invitation registration rejects malformed input before database access', async () => {
  let connected = false;
  const router = createRouter({ pool: { connect: async () => { connected = true; } }, passwordHasher: async () => 'hash' });
  const res = response();
  await handler(router)({ body: { token: 'short', username: 'a', displayName: 'A', password: 'weak' } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('valid invitation creates a verified user and membership in the invited company atomically', async () => {
  const rawToken = 'invite-token-' + 'x'.repeat(40);
  const calls = [];
  let passwordToHash;
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations i')) return { rowCount: 1, rows: [{
        id: 'invite-1', companyId: 'company-alpha', email: 'New.Member@Example.com',
        role: 'warehouse', status: 'pending', expiresAt: new Date(Date.now() + 60000),
        companyName: 'Impresa Alfa', companyStatus: 'active'
      }] };
      if (sql.includes('FROM app_users')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO app_users')) {
        assert.equal(args[0], 'new.member');
        assert.equal(args[3], 'new.member@example.com');
        assert.match(sql, /'operator'/);
        assert.match(sql, /email_verified_at/);
        return { rowCount: 1, rows: [{ id: 'user-new', username: 'new.member' }] };
      }
      if (sql.includes('INSERT INTO company_memberships')) {
        assert.deepEqual(args, ['company-alpha', 'user-new', 'warehouse']);
        return { rowCount: 1, rows: [{ id: 'membership-new' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const router = createRouter({
    pool: { connect: async () => client },
    passwordHasher: async password => { passwordToHash = password; return 'secure-hash'; }
  });
  const res = response();
  await handler(router)({
    body: { token: rawToken, username: 'New.Member', displayName: 'Nuovo membro', password: 'a-very-strong-password' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(passwordToHash, 'a-very-strong-password');
  assert.equal(res.body.data.companyName, 'Impresa Alfa');
  assert.equal(res.body.data.role, 'warehouse');
  assert.equal(res.body.data.username, 'new.member');
  const invitationLookup = calls.find(call => call.sql.includes('FROM company_invitations i'));
  assert.equal(invitationLookup.args[0], crypto.createHash('sha256').update(rawToken).digest('hex'));
  assert.ok(calls.some(call => call.sql.includes('UPDATE company_invitations')));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO audit_log')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false);
});

test('expired invitation is marked expired without creating an account', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations i')) return { rowCount: 1, rows: [{
        id: 'invite-old', companyId: 'company-alpha', email: 'old@example.com',
        role: 'operator', status: 'pending', expiresAt: new Date(Date.now() - 1000),
        companyName: 'Impresa Alfa', companyStatus: 'active'
      }] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const router = createRouter({ pool: { connect: async () => client }, passwordHasher: async () => 'hash' });
  const res = response();
  await handler(router)({ body: { token: 't'.repeat(48), username: 'old.user', displayName: 'Old User', password: 'a-very-strong-password' } }, res, error => { throw error; });
  assert.equal(res.statusCode, 410);
  assert.ok(calls.some(sql => sql.includes("status = 'expired'")));
  assert.equal(calls.some(sql => sql.includes('INSERT INTO app_users')), false);
  assert.ok(calls.includes('COMMIT'));
});

test('registration rejects an existing username or email and rolls back', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM company_invitations i')) return { rowCount: 1, rows: [{
        id: 'invite-2', companyId: 'company-alpha', email: 'existing@example.com',
        role: 'operator', status: 'pending', expiresAt: new Date(Date.now() + 60000),
        companyName: 'Impresa Alfa', companyStatus: 'active'
      }] };
      if (sql.includes('FROM app_users')) return { rowCount: 1, rows: [{ id: 'existing-user' }] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const router = createRouter({ pool: { connect: async () => client }, passwordHasher: async () => 'hash' });
  const res = response();
  await handler(router)({ body: { token: 't'.repeat(48), username: 'existing', displayName: 'Existing User', password: 'a-very-strong-password' } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(sql => sql.includes('INSERT INTO app_users')), false);
});
