'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createAuth = require('../auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    cleared: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cleared.push({ name, options }); return this; }
  };
}

function postHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, 'missing POST ' + path);
  return layer.route.stack.at(-1).handle;
}

function totp(secret, time = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const key = Buffer.from(bytes);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(number % 1000000).padStart(6, '0');
}

function encryptSecret(secret, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}

test('one MFA challenge cannot mint two sessions under concurrent verification', async () => {
  const previousKey = process.env.TOTP_ENCRYPTION_KEY;
  const keyHex = crypto.randomBytes(32).toString('hex');
  process.env.TOTP_ENCRYPTION_KEY = keyHex;

  const secret = 'JBSWY3DPEHPK3PXP';
  const encryptedSecret = encryptSecret(secret, keyHex);
  let selected = 0;
  let releaseSelections;
  const bothSelections = new Promise(resolve => { releaseSelections = resolve; });
  let challengeAvailable = true;
  let sessionsCreated = 0;

  const pool = {
    async query(sql) {
      if (sql.includes('FROM app_mfa_challenges c JOIN app_users u')) {
        selected += 1;
        if (selected === 2) releaseSelections();
        await bothSelections;
        return {
          rowCount: 1,
          rows: [{
            user_id: 'user-1',
            attempts: 0,
            username: 'admin',
            displayName: 'Admin',
            role: 'admin',
            totp_secret_enc: encryptedSecret,
            recovery_codes_hashes: []
          }]
        };
      }
      if (sql.startsWith('DELETE FROM app_mfa_challenges WHERE token_hash=$1 AND expires_at>NOW()')) {
        if (!challengeAvailable) return { rowCount: 0, rows: [] };
        challengeAvailable = false;
        return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      }
      if (sql.includes('INSERT INTO app_sessions')) {
        sessionsCreated += 1;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE app_users SET last_login_at')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    }
  };

  try {
    const router = createAuth(pool).router;
    const handler = postHandler(router, '/mfa/verify-login');
    const currentCode = totp(secret);
    const makeRequest = () => ({
      cookies: { fs_mfa_challenge: 'same-login-challenge-token' },
      body: { code: currentCode },
      ip: '127.0.0.1'
    });
    const first = response();
    const second = response();

    await Promise.all([
      handler(makeRequest(), first, error => { throw error; }),
      handler(makeRequest(), second, error => { throw error; })
    ]);

    assert.equal([first, second].filter(res => res.statusCode === 200).length, 1);
    assert.equal([first, second].filter(res => res.statusCode === 401).length, 1);
    assert.equal(sessionsCreated, 1);
  } finally {
    if (previousKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = previousKey;
  }
});
