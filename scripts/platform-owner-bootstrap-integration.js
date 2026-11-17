'use strict';

// End-to-end bootstrap tests against the disposable PostgreSQL service in CI.
// Refuses non-local database hosts and production mode.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const createAuth = require('../auth');

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port };
}

async function post(baseUrl, body) {
  return fetch(baseUrl + '/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; use disposable PostgreSQL only.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run bootstrap integration tests in production.');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
    throw new Error('Refusing to run bootstrap integration tests against a non-local database host.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const previousToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
  const token = crypto.randomBytes(32).toString('hex');
  const prefix = 'zz_platform_it_' + process.pid + '_' + crypto.randomBytes(4).toString('hex') + '_';
  const legacyUsername = prefix + 'legacy';
  const app = express();
  app.use(express.json({ limit: '30kb' }));
  app.use('/auth', createAuth(pool).router);
  let running;
  let ownerIds = [];

  try {
    await pool.query(
      "INSERT INTO app_users(username, display_name, password_hash, role) VALUES($1, 'Legacy test admin', 'test-only-hash', 'admin')",
      [legacyUsername]
    );

    process.env.BOOTSTRAP_ADMIN_TOKEN = token;
    running = await listen(app);

    const invalid = await post(running.baseUrl, {
      token: 'x'.repeat(24), username: prefix + 'invalid', displayName: 'Invalid Token', password: 'Test-only-password-123!'
    });
    assert.equal(invalid.status, 403, 'An invalid bootstrap token must be rejected.');
    const invalidAccount = await pool.query('SELECT 1 FROM app_users WHERE username=$1', [prefix + 'invalid']);
    assert.equal(invalidAccount.rowCount, 0, 'An invalid token must not create an account.');

    const first = await post(running.baseUrl, {
      token, username: prefix + 'first', displayName: 'Bootstrap Owner', password: 'Test-only-password-123!'
    });
    assert.equal(first.status, 201, 'The first valid bootstrap must create the platform owner.');
    const firstPayload = await first.json();
    assert.equal(firstPayload.data.role, 'platform_owner');
    const firstId = firstPayload.data.id;
    ownerIds.push(firstId);

    const identity = await pool.query(
      'SELECT id, role FROM app_users WHERE id=$1', [firstId]
    );
    assert.equal(identity.rowCount, 1);
    assert.equal(identity.rows[0].role, 'platform_owner');

    const access = await pool.query(
      "SELECT role, status FROM platform_access WHERE user_id=$1", [firstId]
    );
    assert.deepEqual(access.rows, [{ role: 'owner', status: 'active' }]);

    const membership = await pool.query(
      'SELECT 1 FROM company_memberships WHERE user_id=$1', [firstId]
    );
    assert.equal(membership.rowCount, 0, 'The platform owner must not receive a company membership.');

    const state = await pool.query(
      'SELECT consumed_at, consumed_by FROM platform_bootstrap_state WHERE singleton=TRUE'
    );
    assert.equal(state.rowCount, 1);
    assert.ok(state.rows[0].consumed_at);
    assert.equal(state.rows[0].consumed_by, firstId);

    const audit = await pool.query(
      "SELECT 1 FROM audit_log WHERE user_id=$1 AND action='platform.owner.bootstrap.created'", [firstId]
    );
    assert.equal(audit.rowCount, 1, 'The owner creation must be audited in the same successful operation.');

    const legacy = await pool.query('SELECT role FROM app_users WHERE username=$1', [legacyUsername]);
    assert.equal(legacy.rows[0].role, 'admin', 'Existing legacy admins must not be promoted or rewritten.');
    const legacyAccess = await pool.query('SELECT 1 FROM platform_access WHERE user_id=(SELECT id FROM app_users WHERE username=$1)', [legacyUsername]);
    assert.equal(legacyAccess.rowCount, 0, 'Existing legacy admins must not receive platform access.');

    const reused = await post(running.baseUrl, {
      token, username: prefix + 'reused', displayName: 'Second Owner', password: 'Test-only-password-123!'
    });
    assert.equal(reused.status, 409, 'A consumed bootstrap token must not be reusable.');

    // Reset only the disposable test fixture, then race two real HTTP requests
    // through separate PostgreSQL pool connections against the same singleton row.
    await pool.query("DELETE FROM audit_log WHERE action='platform.owner.bootstrap.created' AND username LIKE $1", [prefix + '%']);
    await pool.query('DELETE FROM app_users WHERE username=$1', [prefix + 'first']);
    ownerIds = [];
    await pool.query('UPDATE platform_bootstrap_state SET consumed_at=NULL, consumed_by=NULL WHERE singleton=TRUE');

    const concurrentBodies = ['race_a', 'race_b'].map(name => ({
      token, username: prefix + name, displayName: 'Concurrent Owner', password: 'Test-only-password-123!'
    }));
    const raced = await Promise.all(concurrentBodies.map(body => post(running.baseUrl, body)));
    const statuses = raced.map(response => response.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409], 'Exactly one of two concurrent bootstrap requests must succeed.');

    const owners = await pool.query(
      "SELECT u.id, u.username FROM app_users u JOIN platform_access p ON p.user_id=u.id WHERE u.username LIKE $1 AND u.role='platform_owner' AND p.role='owner' AND p.status='active'",
      [prefix + 'race_%']
    );
    assert.equal(owners.rowCount, 1, 'Concurrent requests must leave exactly one active platform owner.');
    ownerIds.push(owners.rows[0].id);

    const finalState = await pool.query(
      'SELECT consumed_at, consumed_by FROM platform_bootstrap_state WHERE singleton=TRUE'
    );
    assert.ok(finalState.rows[0].consumed_at);
    assert.equal(finalState.rows[0].consumed_by, owners.rows[0].id);

    process.stdout.write([
      'PASS: invalid bootstrap token creates no account.',
      'PASS: valid bootstrap creates a separate platform_owner and active owner access row.',
      'PASS: platform owner receives no company membership.',
      'PASS: bootstrap state and audit event are persisted.',
      'PASS: legacy admin remains unchanged and receives no platform access.',
      'PASS: consumed bootstrap token cannot be reused.',
      'PASS: concurrent HTTP requests produce exactly one owner and one HTTP 409.'
    ].join('\n') + '\n');
  } finally {
    if (running) await new Promise(resolve => running.server.close(resolve));
    try {
      await pool.query("DELETE FROM audit_log WHERE action='platform.owner.bootstrap.created' AND username LIKE $1", [prefix + '%']);
      await pool.query('DELETE FROM app_users WHERE username LIKE $1', [prefix + '%']);
      await pool.query('UPDATE platform_bootstrap_state SET consumed_at=NULL, consumed_by=NULL WHERE singleton=TRUE');
    } finally {
      await pool.end();
      if (previousToken === undefined) delete process.env.BOOTSTRAP_ADMIN_TOKEN;
      else process.env.BOOTSTRAP_ADMIN_TOKEN = previousToken;
    }
  }
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
