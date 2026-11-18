'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Pool } = require('pg');
const createProviderPortalRouter = require('../provider-portal-routes');

async function main() {
  if (process.env.RUN_PROVIDER_PORTAL_POSTGRES_TESTS !== 'true') {
    throw new Error('Set RUN_PROVIDER_PORTAL_POSTGRES_TESTS=true to run this disposable-database integration test.');
  }
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === 'production') {
    throw new Error('A non-production local DATABASE_URL is required.');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
    throw new Error('Refusing non-local database host.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const userId = crypto.randomUUID();
  const alphaId = crypto.randomUUID();
  const betaId = crypto.randomUUID();
  const alphaInquiryId = crypto.randomUUID();
  const betaInquiryId = crypto.randomUUID();
  const alphaAssignmentId = crypto.randomUUID();
  const betaAssignmentId = crypto.randomUUID();
  const rejectInquiryId = crypto.randomUUID();
  const rejectAssignmentId = crypto.randomUUID();
  let server;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/provider-portal', createProviderPortalRouter(pool, {
    authenticate(req, _res, next) {
      req.user = { id: userId, username: 'ci_provider_' + suffix };
      next();
    }
  }));

  async function call(pathname, method = 'GET', body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/provider-portal' + pathname, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { raw: text }; }
    return { status: response.status, data, headers: response.headers };
  }

  try {
    const migration = await fs.readFile(path.join(__dirname, '..', 'migrations', '015_provider_portal_access.draft.sql'), 'utf8');
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query('BEGIN');
      await migrationClient.query(migration);
      await migrationClient.query('COMMIT');
    } catch (error) {
      await migrationClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      migrationClient.release();
    }

    await pool.query(
      "INSERT INTO app_users(id,username,display_name,password_hash,role,active) VALUES($1,$2,$3,$4,'operator',TRUE)",
      [userId, 'ci_provider_' + suffix, 'Provider Portal Integration Test', 'test-only-not-a-real-password-hash']
    );
    await pool.query(
      "INSERT INTO providers(id,business_name,vat_number,city,status,verification_date) VALUES($1,$2,$3,'Torino','verified',NOW()),($4,$5,$6,'Milano','verified',NOW())",
      [alphaId, 'CI Provider Alfa ' + suffix, 'AL' + suffix, betaId, 'CI Provider Beta ' + suffix, 'BE' + suffix]
    );
    await pool.query(
      "INSERT INTO provider_user_access(provider_id,user_id,role,status) VALUES($1,$2,'provider_admin','active')",
      [alphaId, userId]
    );
    await pool.query(
      "INSERT INTO inquiries(id,city,service_type,destination_country,budget_euro,notes,contact_email,contact_phone,privacy_consent,status) VALUES($1,'Torino','burial',NULL,2000,'NOT FOR PROVIDER','alpha-'||$2||'@example.invalid','011000000',TRUE,'assigned'),($3,'Milano','cremation',NULL,3000,'BETA PRIVATE NOTE','beta-'||$2||'@example.invalid','022000000',TRUE,'assigned'),($4,'Torino','assistance',NULL,1000,'ANOTHER PRIVATE NOTE','reject-'||$2||'@example.invalid','011000001',TRUE,'assigned')",
      [alphaInquiryId, suffix, betaInquiryId, rejectInquiryId]
    );
    await pool.query(
      "INSERT INTO inquiry_provider_assignments(id,inquiry_id,provider_id,status) VALUES($1,$2,$3,'active'),($4,$5,$6,'active'),($7,$8,$3,'active')",
      [alphaAssignmentId, alphaInquiryId, alphaId, betaAssignmentId, betaInquiryId, betaId, rejectAssignmentId, rejectInquiryId]
    );

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const profile = await call('/me');
    assert.equal(profile.status, 200);
    assert.equal(profile.data.data.providerId, alphaId);
    assert.equal(profile.data.data.businessName, 'CI Provider Alfa ' + suffix);

    const list = await call('/inquiries');
    assert.equal(list.status, 200);
    assert.equal(list.data.data.length, 2);
    assert.ok(list.data.data.every(row => row.assignmentId === alphaAssignmentId || row.assignmentId === rejectAssignmentId));
    assert.ok(list.data.data.every(row => !('contactEmail' in row) && !('contactPhone' in row) && !('notes' in row) && !('budgetEuro' in row)));
    assert.equal(JSON.stringify(list.data).includes('BETA PRIVATE NOTE'), false);

    const dashboard = await call('/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.data.counts.newCount, 2);

    const detailBeforeResponse = await call('/inquiries/' + alphaAssignmentId);
    assert.equal(detailBeforeResponse.status, 200);
    assert.equal(detailBeforeResponse.data.data.contactEmail, null);
    assert.equal(detailBeforeResponse.data.data.contactPhone, null);
    assert.equal(JSON.stringify(detailBeforeResponse.data).includes('NOT FOR PROVIDER'), false);

    const crossProvider = await call('/inquiries/' + betaAssignmentId + '/response', 'POST', {
      status: 'accepted',
      reason: 'Tentativo di accesso non autorizzato.'
    });
    assert.equal(crossProvider.status, 404);

    const concurrentResponses = await Promise.all([
      call('/inquiries/' + alphaAssignmentId + '/response', 'POST', {
        status: 'accepted',
        reason: 'Impresa Alfa accetta la richiesta.'
      }),
      call('/inquiries/' + alphaAssignmentId + '/response', 'POST', {
        status: 'rejected',
        reason: 'Impresa Alfa rifiuta la richiesta.'
      })
    ]);
    assert.deepEqual(concurrentResponses.map(item => item.status).sort(), [201, 409]);

    const reject = await call('/inquiries/' + rejectAssignmentId + '/response', 'POST', {
      status: 'rejected',
      reason: 'Non possiamo svolgere il servizio richiesto.'
    });
    assert.equal(reject.status, 201);
    assert.equal(reject.data.data.status, 'rejected');

    const acceptedStatus = await pool.query(
      'SELECT status FROM provider_inquiry_responses WHERE assignment_id=$1',
      [alphaAssignmentId]
    );
    const detailAfterResponse = await call('/inquiries/' + alphaAssignmentId);
    assert.equal(detailAfterResponse.status, 200);
    if (acceptedStatus.rows[0].status === 'accepted') {
      assert.equal(detailAfterResponse.data.data.contactEmail, 'alpha-' + suffix + '@example.invalid');
      assert.equal(detailAfterResponse.data.data.contactPhone, '011000000');
    } else {
      assert.equal(detailAfterResponse.data.data.contactEmail, null);
      assert.equal(detailAfterResponse.data.data.contactPhone, null);
    }

    const rejectedDetail = await call('/inquiries/' + rejectAssignmentId);
    assert.equal(rejectedDetail.status, 200);
    assert.equal(rejectedDetail.data.data.contactEmail, null);
    assert.equal(rejectedDetail.data.data.contactPhone, null);

    const responses = await pool.query(
      'SELECT assignment_id,status,provider_id FROM provider_inquiry_responses WHERE assignment_id = ANY($1::uuid[])',
      [[alphaAssignmentId, rejectAssignmentId]]
    );
    assert.equal(responses.rowCount, 2);
    assert.ok(responses.rows.every(row => row.provider_id === alphaId));

    const audit = await pool.query(
      'SELECT action,reason FROM provider_portal_audit_log WHERE provider_id=$1 AND assignment_id = ANY($2::uuid[])',
      [alphaId, [alphaAssignmentId, rejectAssignmentId]]
    );
    assert.equal(audit.rowCount, 2);
    assert.ok(audit.rows.some(row => row.action === 'inquiry.accepted' || row.action === 'inquiry.rejected'));
    assert.ok(audit.rows.some(row => row.action === 'inquiry.rejected'));
    assert.equal(JSON.stringify(audit.rows).includes('alpha-' + suffix + '@example.invalid'), false);

    process.stdout.write('Provider portal PostgreSQL integration checks passed.\\n');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.query('DELETE FROM provider_portal_audit_log WHERE user_id=$1', [userId]).catch(() => {});
    await pool.query('DELETE FROM provider_inquiry_responses WHERE assignment_id = ANY($1::uuid[])', [[alphaAssignmentId, betaAssignmentId, rejectAssignmentId]]).catch(() => {});
    await pool.query('DELETE FROM inquiry_provider_assignments WHERE id = ANY($1::uuid[])', [[alphaAssignmentId, betaAssignmentId, rejectAssignmentId]]).catch(() => {});
    await pool.query('DELETE FROM inquiries WHERE id = ANY($1::uuid[])', [[alphaInquiryId, betaInquiryId, rejectInquiryId]]).catch(() => {});
    await pool.query('DELETE FROM provider_user_access WHERE user_id=$1', [userId]).catch(() => {});
    await pool.query('DELETE FROM providers WHERE id = ANY($1::uuid[])', [[alphaId, betaId]]).catch(() => {});
    await pool.query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
