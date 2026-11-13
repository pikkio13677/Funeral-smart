'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const createAuth = require('../auth');

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function postHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, 'missing POST ' + path);
  return layer.route.stack.at(-1).handle;
}

function makePool(account) {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM app_sessions WHERE token_hash=$1')) return { rowCount: 1, rows: [{ id: 'session-1' }] };
      if (sql.includes('FROM app_users WHERE id=$1 FOR UPDATE')) return { rowCount: 1, rows: [account] };
      if (sql.startsWith('UPDATE app_users SET recovery_codes_hashes=')) {
        const index = account.recovery_codes_hashes.indexOf(args[0]);
        if (index < 0) return { rowCount: 0, rows: [] };
        account.recovery_codes_hashes.splice(index, 1);
        return { rowCount: 1, rows: [{ id: account.id }] };
      }
      if (sql.startsWith('UPDATE app_users SET password_hash=')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('DELETE FROM app_sessions')) return { rowCount: 2, rows: [] };
      if (sql.startsWith('DELETE FROM app_mfa_challenges')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  return {
    calls,
    connect: async () => client,
    query: async () => ({ rowCount: 1, rows: [] })
  };
}

test('password change verifies current password and revokes other sessions atomically', async () => {
  const stored = await passwordHash('Current-password-123');
  const pool = makePool({
    id: 'user-1', username: 'admin', password_hash: stored, active: true,
    totp_enabled_at: null, totp_secret_enc: null, recovery_codes_hashes: []
  });
  const handler = postHandler(createAuth(pool).router, '/password/change');
  const res = response();
  await handler({
    user: { id: 'user-1', username: 'admin' },
    cookies: { fs_session: 's'.repeat(43) },
    body: { currentPassword: 'Current-password-123', newPassword: 'New-password-456' },
    ip: '127.0.0.1'
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /altre sessioni sono state chiuse/);
  assert.ok(pool.calls.some(call => call.sql.startsWith('UPDATE app_users SET password_hash=')));
  assert.ok(pool.calls.some(call => call.sql.startsWith('DELETE FROM app_sessions')));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('password change rejects an incorrect current password without updating the account', async () => {
  const stored = await passwordHash('Current-password-123');
  const pool = makePool({
    id: 'user-1', username: 'admin', password_hash: stored, active: true,
    totp_enabled_at: null, totp_secret_enc: null, recovery_codes_hashes: []
  });
  const handler = postHandler(createAuth(pool).router, '/password/change');
  const res = response();
  await handler({
    user: { id: 'user-1' },
    cookies: { fs_session: 's'.repeat(43) },
    body: { currentPassword: 'Wrong-password-123', newPassword: 'New-password-456' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 401);
  assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE app_users SET password_hash=')), false);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('password change requires a fresh MFA proof when MFA is enabled', async () => {
  const stored = await passwordHash('Current-password-123');
  const pool = makePool({
    id: 'user-1', username: 'admin', password_hash: stored, active: true,
    totp_enabled_at: new Date(), totp_secret_enc: 'unreadable-without-code', recovery_codes_hashes: []
  });
  const handler = postHandler(createAuth(pool).router, '/password/change');
  const res = response();
  await handler({
    user: { id: 'user-1' },
    cookies: { fs_session: 's'.repeat(43) },
    body: { currentPassword: 'Current-password-123', newPassword: 'New-password-456' }
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 403);
  assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE app_users SET password_hash=')), false);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});


test('password change accepts a recovery code, normalizes whitespace, and consumes it once', async () => {
  const stored = await passwordHash('Current-password-123');
  const recoveryCode = 'A1B2C3D4E5';
  const recoveryHash = crypto.createHash('sha256').update(recoveryCode).digest('hex');
  const account = {
    id: 'user-1', username: 'admin', password_hash: stored, active: true,
    totp_enabled_at: new Date(), totp_secret_enc: 'invalid-encrypted-secret',
    recovery_codes_hashes: [recoveryHash]
  };
  const pool = makePool(account);
  const handler = postHandler(createAuth(pool).router, '/password/change');
  const res = response();
  await handler({
    user: { id: 'user-1', username: 'admin' },
    cookies: { fs_session: 's'.repeat(43) },
    body: {
      currentPassword: 'Current-password-123',
      newPassword: 'New-password-456',
      mfaCode: 'A1B2 C3D4E5'
    },
    ip: '127.0.0.1'
  }, res, error => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(account.recovery_codes_hashes, []);
  assert.ok(pool.calls.some(call => call.sql.startsWith('UPDATE app_users SET recovery_codes_hashes=')));
  assert.ok(pool.calls.some(call => call.sql.startsWith('UPDATE app_users SET password_hash=')));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});
