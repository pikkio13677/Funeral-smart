'use strict';

// Real PostgreSQL integration test. Runs only against the disposable DATABASE_URL
// provisioned by GitHub Actions; never point this script at Render/production.
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Client } = require('pg');
const createTenantCustomersCasesRouter = require('../tenant-customers-cases-routes');

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; use disposable PostgreSQL only.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run tenant integration tests in production.');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  await client.connect();
  let alfaServer;
  let betaServer;
  await client.query('BEGIN');
  try {
    const alfa = (await client.query("INSERT INTO companies (legal_name) VALUES ('Alfa Test S.r.l.') RETURNING id")).rows[0].id;
    const beta = (await client.query("INSERT INTO companies (legal_name) VALUES ('Beta Test S.r.l.') RETURNING id")).rows[0].id;

    const alfaCustomer = (await client.query(
      "INSERT INTO customers (company_id, first_name, last_name) VALUES ($1, 'Cliente', 'Alfa') RETURNING id", [alfa]
    )).rows[0].id;
    const betaCustomer = (await client.query(
      "INSERT INTO customers (company_id, first_name, last_name) VALUES ($1, 'Cliente', 'Beta') RETURNING id", [beta]
    )).rows[0].id;

    const alfaCase = (await client.query(
      "INSERT INTO funeral_cases (company_id, case_code, customer_id, deceased_first_name, deceased_last_name, service_type) VALUES ($1, 'IT-ALFA-TEST', $2, 'Defunto', 'Alfa', 'burial') RETURNING id",
      [alfa, alfaCustomer]
    )).rows[0].id;
    const betaCase = (await client.query(
      "INSERT INTO funeral_cases (company_id, case_code, customer_id, deceased_first_name, deceased_last_name, service_type) VALUES ($1, 'IT-BETA-TEST', $2, 'Defunto', 'Beta', 'burial') RETURNING id",
      [beta, betaCustomer]
    )).rows[0].id;

    function appFor(companyId, suffix) {
      const app = express();
      app.use(express.json());
      // Test-only identity injection. Production identity comes from verified session membership.
      app.use((req, _res, next) => {
        req.tenant = {
          companyId,
          membershipId: '00000000-0000-4000-8000-' + suffix.padStart(12, '0'),
          role: 'admin'
        };
        next();
      });
      app.use('/admin', createTenantCustomersCasesRouter(client));
      return app;
    }

    alfaServer = await listen(appFor(alfa, '1'));
    betaServer = await listen(appFor(beta, '2'));

    const alfaCustomersResponse = await fetch(alfaServer.baseUrl + '/admin/customers');
    assert.equal(alfaCustomersResponse.status, 200);
    const alfaCustomers = await alfaCustomersResponse.json();
    assert.deepEqual(alfaCustomers.data.map(row => row.id), [alfaCustomer],
      'Alfa must see only Alfa customers');

    const betaCustomersResponse = await fetch(betaServer.baseUrl + '/admin/customers');
    assert.equal(betaCustomersResponse.status, 200);
    const betaCustomers = await betaCustomersResponse.json();
    assert.deepEqual(betaCustomers.data.map(row => row.id), [betaCustomer],
      'Beta must see only Beta customers');

    const alfaCases = await (await fetch(alfaServer.baseUrl + '/admin/cases')).json();
    assert.deepEqual(alfaCases.data.map(row => row.id), [alfaCase],
      'Alfa must see only Alfa cases');
    const betaCases = await (await fetch(betaServer.baseUrl + '/admin/cases')).json();
    assert.deepEqual(betaCases.data.map(row => row.id), [betaCase],
      'Beta must see only Beta cases');

    const crossTenantUpdate = await fetch(alfaServer.baseUrl + '/admin/cases/' + betaCase + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(crossTenantUpdate.status, 404,
      'Alfa must not update a Beta case by guessing its UUID');

    const crossTenantCreate = await fetch(alfaServer.baseUrl + '/admin/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caseCode: 'IT-ALFA-CROSS-TEST',
        customerId: betaCustomer,
        deceasedFirstName: 'Test',
        deceasedLastName: 'Cross Tenant',
        serviceType: 'burial'
      })
    });
    assert.equal(crossTenantCreate.status, 400,
      'Alfa must not create a case linked to a Beta customer');

    const betaStatus = await client.query(
      'SELECT status FROM funeral_cases WHERE id = $1 AND company_id = $2',
      [betaCase, beta]
    );
    assert.equal(betaStatus.rows[0].status, 'open',
      'Denied cross-tenant update must leave Beta data unchanged');

    process.stdout.write([
      'PASS: Alfa and Beta see only their own customers.',
      'PASS: Alfa and Beta see only their own cases.',
      'PASS: IDOR-style cross-tenant case update is denied.',
      'PASS: Cross-tenant customer reference on case creation is denied.',
      'PASS: Denied write leaves Beta data unchanged.'
    ].join('\n') + '\n');
  } finally {
    if (alfaServer) await new Promise(resolve => alfaServer.server.close(resolve));
    if (betaServer) await new Promise(resolve => betaServer.server.close(resolve));
    await client.query('ROLLBACK');
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
