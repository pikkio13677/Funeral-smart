'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const createPlatformAccess = require('../platform-access');
const createPlatformCompanyRouter = require('../platform-company-routes');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
  throw new Error('Refusing platform company integration test against a non-local database host.');
}
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run platform company integration tests in production.');

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const ownerId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const companyId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const ownerUsername = 'platform_api_owner_' + suffix;
const adminUsername = 'platform_api_admin_' + suffix;
const memberUsername = 'platform_api_member_' + suffix;

async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

async function insertUser(id, username, role) {
  await pool.query(
    'INSERT INTO app_users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)',
    [id, username, username, 'integration-test-not-a-real-password-hash', role]
  );
}

async function main() {
  const platformAccess = createPlatformAccess(pool);
  await insertUser(ownerId, ownerUsername, 'platform_owner');
  await insertUser(adminId, adminUsername, 'admin');
  await insertUser(memberId, memberUsername, 'operator');
  await pool.query(
    "INSERT INTO platform_access(user_id,role,status) VALUES($1,'owner','active')",
    [ownerId]
  );
  await pool.query(
    'INSERT INTO companies(id,legal_name,vat_number,status,plan_code) VALUES($1,$2,$3,$4,$5)',
    [companyId, 'API Integration ' + suffix, 'IT' + suffix, 'active', 'trial']
  );
  await pool.query(
    "INSERT INTO company_memberships(company_id,user_id,role,status) VALUES($1,$2,'operator','active')",
    [companyId, memberId]
  );

  const ownerAuthenticate = (req, _res, next) => {
    req.user = { id: ownerId, username: ownerUsername, role: 'platform_owner' };
    next();
  };
  const ownerRouter = createPlatformCompanyRouter(pool, {
    authenticate: ownerAuthenticate,
    requirePlatformRole: platformAccess.requirePlatformRole
  });

  await withServer(ownerRouter, async base => {
    const list = await fetch(base + '/api/v1/platform/companies?q=' + encodeURIComponent('API Integration ' + suffix));
    assert.equal(list.status, 200, 'active platform owner can list companies');
    const listBody = await list.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].id, companyId);

    const detail = await fetch(base + '/api/v1/platform/companies/' + companyId);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.memberCount, 1);
    assert.equal(detailBody.data.activeMemberCount, 1);

    const members = await fetch(base + '/api/v1/platform/companies/' + companyId + '/members');
    assert.equal(members.status, 200);
    const memberBody = await members.json();
    assert.equal(memberBody.data.length, 1);
    assert.equal(memberBody.data[0].userId, memberId);
    assert.equal('password_hash' in memberBody.data[0], false);

    const suspend = await fetch(base + '/api/v1/platform/companies/' + companyId + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Integration test suspension reason' })
    });
    assert.equal(suspend.status, 200);
    const audit = await pool.query(
      "SELECT action,resource,resource_id,reason FROM platform_audit_log WHERE actor_user_id=$1 AND resource_id=$2",
      [ownerId, companyId]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].action, 'platform.company.suspended');
    assert.equal(audit.rows[0].resource, 'company');
    assert.equal(audit.rows[0].reason, 'Integration test suspension reason');

    const reactivate = await fetch(base + '/api/v1/platform/companies/' + companyId + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'Integration test reactivation reason' })
    });
    assert.equal(reactivate.status, 200);
  });

  const noAccessRouter = createPlatformCompanyRouter(pool, {
    authenticate: (req, _res, next) => {
      req.user = { id: adminId, username: adminUsername, role: 'admin' };
      next();
    },
    requirePlatformRole: platformAccess.requirePlatformRole
  });
  await withServer(noAccessRouter, async base => {
    const denied = await fetch(base + '/api/v1/platform/companies');
    assert.equal(denied.status, 403, 'legacy admin without platform_access is denied');
  });

  await pool.query("UPDATE platform_access SET status='suspended' WHERE user_id=$1", [ownerId]);
  await withServer(ownerRouter, async base => {
    const denied = await fetch(base + '/api/v1/platform/companies');
    assert.equal(denied.status, 403, 'suspended platform owner is denied on the next request');
  });

  console.log('PASS: PostgreSQL platform company API integration, owner authorization, company listing/detail/members, transactional status audit, and suspended-owner denial.');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try {
      await pool.query('DELETE FROM platform_audit_log WHERE actor_user_id=$1', [ownerId]);
      await pool.query('DELETE FROM platform_access WHERE user_id=$1', [ownerId]);
      await pool.query('DELETE FROM company_memberships WHERE company_id=$1', [companyId]);
      await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[ownerId, adminId, memberId]]);
    } catch (cleanupError) {
      console.error('Integration fixture cleanup failed:', cleanupError);
      process.exitCode = 1;
    }
    await pool.end();
  });
