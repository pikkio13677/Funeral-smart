'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createAuth = require('../auth');
const { createResendVerificationSender } = require('../resend-email');

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
function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('email verification request sends a short-lived code and stores only its digest', async () => {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id, email, email_verified_at')) return { rowCount: 1, rows: [{ id: 'user-1', email: null, emailVerifiedAt: null }] };
      if (sql.includes('SELECT COUNT(*)::int AS total FROM email_verification_challenges')) return { rowCount: 1, rows: [{ total: 0 }] };
      if (sql.includes('DELETE FROM email_verification_challenges')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO email_verification_challenges')) return { rowCount: 1, rows: [{ id: 'challenge-1' }] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  const pool = { connect: async () => client, query: async () => ({ rowCount: 1, rows: [] }) };
  let sent;
  const router = createAuth(pool, { sendVerificationEmail: async value => { sent = value; } }).router;
  const res = response();
  await postHandler(router, '/email/verification/request')(
    { user: { id: 'user-1' }, body: { email: ' COLLEGA@Example.com ' } }, res, error => { throw error; }
  );
  assert.equal(res.statusCode, 202);
  assert.equal(sent.to, 'collega@example.com');
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(sent.expiresInMinutes, 15);
  const insert = calls.find(call => call.sql.includes('INSERT INTO email_verification_challenges'));
  assert.equal(insert.args[1], 'collega@example.com');
  assert.equal(insert.args[2], digest(sent.code));
  assert.notEqual(insert.args[2], sent.code);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.doesNotMatch(JSON.stringify(res.body), /\d{6}/);
});

test('email verification request refuses unconfigured delivery without creating a challenge', async () => {
  let connected = false;
  const router = createAuth({ query: async () => ({}), connect: async () => { connected = true; } }).router;
  const res = response();
  await postHandler(router, '/email/verification/request')(
    { user: { id: 'user-1' }, body: { email: 'user@example.com' } }, res, error => { throw error; }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(connected, false);
});

test('email verification confirmation updates only the authenticated account and consumes the code', async () => {
  const code = '482915';
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM email_verification_challenges')) return { rowCount: 1, rows: [{
        id: 'challenge-1', email: 'member@example.com', code_hash: digest(code), attempts: 0
      }] };
      if (sql.includes('UPDATE app_users')) return { rowCount: 1, rows: [{
        id: 'user-1', email: 'member@example.com', emailVerifiedAt: new Date('2026-11-13T12:00:00Z')
      }] };
      if (sql.includes('UPDATE email_verification_challenges SET consumed_at')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  const router = createAuth({ connect: async () => client, query: async () => ({ rowCount: 1, rows: [] }) }).router;
  const res = response();
  await postHandler(router, '/email/verification/confirm')(
    { user: { id: 'user-1' }, body: { code } }, res, error => { throw error; }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.email, 'member@example.com');
  assert.ok(calls.some(call => call.sql.includes('WHERE id=$2 AND active=TRUE AND email_verified_at IS NULL') && call.args[1] === 'user-1'));
  assert.ok(calls.some(call => call.sql.includes('UPDATE email_verification_challenges SET consumed_at')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('wrong email verification code increments attempts and never changes the account', async () => {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM email_verification_challenges')) return { rowCount: 1, rows: [{
        id: 'challenge-1', email: 'member@example.com', code_hash: digest('111111'), attempts: 0
      }] };
      if (sql.includes('SET attempts=attempts+1')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {}
  };
  const router = createAuth({ connect: async () => client, query: async () => ({ rowCount: 1, rows: [] }) }).router;
  const res = response();
  await postHandler(router, '/email/verification/confirm')(
    { user: { id: 'user-1' }, body: { code: '222222' } }, res, error => { throw error; }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.some(call => call.sql.includes('UPDATE app_users')), false);
  assert.ok(calls.some(call => call.sql.includes('SET attempts=attempts+1')));
});

test('Resend verification email sends code and never exposes provider secrets in errors', async () => {
  let outgoing;
  const send = createResendVerificationSender({
    apiKey: 'test-verification-secret',
    fetchImpl: async (url, options) => {
      outgoing = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'email_verify_123' }) };
    }
  });
  const result = await send({ to: 'USER@example.com', code: '123456', expiresInMinutes: 15 });
  assert.deepEqual(result, { success: true, messageId: 'email_verify_123' });
  assert.equal(outgoing.url, 'https://api.resend.com/emails');
  const payload = JSON.parse(outgoing.options.body);
  assert.deepEqual(payload.to, ['user@example.com']);
  assert.match(payload.text, /123456/);
  assert.match(payload.html, /123456/);
  assert.equal(outgoing.options.headers.Authorization, 'Bearer test-verification-secret');
  const failing = createResendVerificationSender({
    apiKey: 'test-verification-secret',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'private detail' }) })
  });
  await assert.rejects(failing({ to: 'user@example.com', code: '123456' }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /private detail|test-verification-secret/);
    return true;
  });
});
