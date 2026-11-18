'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const { Pool } = require('pg');
const createPlatformMarketplaceRouter = require('../platform-marketplace-routes');

async function main() {
  if (process.env.RUN_PLATFORM_MARKETPLACE_POSTGRES_TESTS !== 'true') {
    throw new Error('Set RUN_PLATFORM_MARKETPLACE_POSTGRES_TESTS=true to run this disposable-database integration test.');
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
  const actorId = crypto.randomUUID();
  const firstApplicationId = crypto.randomUUID();
  const secondApplicationId = crypto.randomUUID();
  const inquiryId = crypto.randomUUID();
  let providerId = null;
  let priceListId = null;
  let server = null;
  let baseUrl = null;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', createPlatformMarketplaceRouter(pool, {
    authenticate(req, _res, next) {
      req.user = { id: actorId, username: 'ci_platform_' + suffix };
      next();
    },
    requirePlatformRole(role) {
      return (_req, res, next) => role === 'owner'
        ? next()
        : res.status(403).json({ error: 'Forbidden' });
    }
  }));

  async function call(path, method = 'GET', body) {
    const response = await fetch(baseUrl + '/api/v1/platform' + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { raw: text }; }
    return { status: response.status, data };
  }

  try {
    await pool.query(
      "INSERT INTO app_users (id,username,display_name,password_hash,role,active) VALUES ($1,$2,$3,$4,'platform_owner',TRUE)",
      [actorId, 'ci_platform_' + suffix, 'Platform Integration Test', 'test-only-not-a-real-password-hash']
    );
    await pool.query(
      "INSERT INTO provider_applications (id,business_name,vat_number,city,province,email,phone,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')",
      [firstApplicationId, 'CI Marketplace ' + suffix, 'CI' + suffix, 'Torino', 'TO', 'ci-' + suffix + '@example.invalid', '011000000']
    );
    await pool.query(
      "INSERT INTO provider_applications (id,business_name,vat_number,city,province,email,phone,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')",
      [secondApplicationId, 'CI Marketplace Reject ' + suffix, 'RJ' + suffix, 'Torino', 'TO', 'reject-' + suffix + '@example.invalid', '011000001']
    );
    await pool.query(
      "INSERT INTO inquiries (id,city,service_type,contact_email,privacy_consent,status) VALUES ($1,'Torino','assistance',$2,TRUE,'received')",
      [inquiryId, 'inquiry-' + suffix + '@example.invalid']
    );

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port;

    const listed = await call('/provider-applications?status=pending');
    assert.equal(listed.status, 200);
    assert.ok(listed.data.data.some(item => item.id === firstApplicationId));

    const approved = await call('/provider-applications/' + firstApplicationId + '/approve', 'POST', {
      reason: 'Candidatura controllata nel test isolato'
    });
    assert.equal(approved.status, 201);
    assert.equal(approved.data.data.status, 'pending');
    providerId = approved.data.data.id;

    const prematureVerification = await call('/providers/' + providerId + '/verify', 'POST', {
      reason: 'Tentativo senza conferma documenti'
    });
    assert.equal(prematureVerification.status, 400);

    const verified = await call('/providers/' + providerId + '/verify', 'POST', {
      documentsReviewed: true,
      reason: 'Documenti fittizi verificati nel test'
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.data.status, 'verified');

    const service = await pool.query('SELECT id FROM service_types WHERE active=TRUE ORDER BY sort_order LIMIT 1');
    assert.ok(service.rowCount, 'an active service type is required');

    const createdPrice = await call('/price-lists', 'POST', {
      providerId,
      serviceTypeId: service.rows[0].id,
      title: 'Listino CI ' + suffix,
      totalEuro: 1250,
      vatIncluded: true,
      includedItems: ['Voce inclusa test'],
      excludedItems: ['Voce esclusa test'],
      thirdPartyCostsNote: 'Costi di terzi da verificare'
    });
    assert.equal(createdPrice.status, 201);
    assert.equal(createdPrice.data.data.published, false);
    priceListId = createdPrice.data.data.id;

    const published = await call('/price-lists/' + priceListId + '/publication', 'PATCH', {
      published: true,
      reason: 'Listino controllato nel test isolato'
    });
    assert.equal(published.status, 200);
    assert.equal(published.data.data.published, true);

    const inquiries = await call('/inquiries?status=received');
    assert.equal(inquiries.status, 200);
    assert.ok(inquiries.data.data.some(item => item.id === inquiryId));
    assert.equal((await call('/providers')).status, 200);
    assert.equal((await call('/price-lists')).status, 200);

    const updatedInquiry = await call('/inquiries/' + inquiryId + '/status', 'PATCH', {
      status: 'reviewed',
      reason: 'Richiesta presa in carico nel test'
    });
    assert.equal(updatedInquiry.status, 200);
    assert.equal(updatedInquiry.data.data.status, 'reviewed');

    const rejected = await call('/provider-applications/' + secondApplicationId + '/reject', 'POST', {
      reason: 'Candidatura rifiutata nel test isolato'
    });
    assert.equal(rejected.status, 200);

    const audit = await pool.query(
      'SELECT action FROM platform_audit_log WHERE actor_user_id=$1',
      [actorId]
    );
    const actions = audit.rows.map(row => row.action);
    for (const action of [
      'platform.provider_application.approved',
      'platform.provider.verified',
      'platform.price_list.created',
      'platform.price_list.published',
      'platform.inquiry.status_changed',
      'platform.inquiry.list_viewed',
      'platform.provider_application.list_viewed',
      'platform.provider.list_viewed',
      'platform.price_list.list_viewed',
      'platform.provider_application.rejected'
    ]) assert.ok(actions.includes(action), 'missing audit action: ' + action);

    process.stdout.write('Platform marketplace PostgreSQL integration checks passed.\\n');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.query('DELETE FROM platform_audit_log WHERE actor_user_id=$1', [actorId]).catch(() => {});
    if (priceListId) await pool.query('DELETE FROM price_lists WHERE id=$1', [priceListId]).catch(() => {});
    if (providerId) await pool.query('DELETE FROM providers WHERE id=$1', [providerId]).catch(() => {});
    await pool.query('DELETE FROM provider_applications WHERE id = ANY($1::uuid[])', [[firstApplicationId, secondApplicationId]]).catch(() => {});
    await pool.query('DELETE FROM inquiries WHERE id=$1', [inquiryId]).catch(() => {});
    await pool.query('DELETE FROM app_users WHERE id=$1', [actorId]).catch(() => {});
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
