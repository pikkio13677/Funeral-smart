'use strict';

// Real PostgreSQL integration test. Runs only against the disposable DATABASE_URL
// provisioned by GitHub Actions; never point this script at Render/production.
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Client } = require('pg');
const crypto = require('node:crypto');
const createTenantCustomersCasesRouter = require('../tenant-customers-cases-routes');
const createTenantContext = require('../tenant-context');
const createTenantStaffVehiclesRouter = require('../tenant-staff-vehicles-routes');
const createTenantInventoryTasksRouter = require('../tenant-inventory-tasks-routes');
const createTenantInvoicesPaymentsRouter = require('../tenant-invoices-payments-routes');
const createTenantDashboardRouter = require('../tenant-dashboard-routes');
const createTenantAuditRouter = require('../tenant-audit-routes');
const createTenantCompanyAdminRouter = require('../tenant-company-admin-routes');

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

    // Create two independent identities and memberships for real session-context tests.
    const alfaUser = (await client.query(
      "INSERT INTO app_users (username, display_name, password_hash, role) VALUES ('alfa_test_user', 'Alfa Test', 'test-only-hash', 'admin') RETURNING id"
    )).rows[0].id;
    const betaUser = (await client.query(
      "INSERT INTO app_users (username, display_name, password_hash, role) VALUES ('beta_test_user', 'Beta Test', 'test-only-hash', 'admin') RETURNING id"
    )).rows[0].id;
    const alfaMembership = (await client.query(
      "INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING id",
      [alfa, alfaUser]
    )).rows[0].id;
    const betaMembership = (await client.query(
      "INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING id",
      [beta, betaUser]
    )).rows[0].id;

    // Fixtures for read-isolation checks across every tenant-aware operational module.
    const staffAlfa = (await client.query(
      "INSERT INTO staff (company_id, first_name, last_name, role) VALUES ($1, 'Staff', 'Alfa', 'Operatore') RETURNING id", [alfa]
    )).rows[0].id;
    const staffBeta = (await client.query(
      "INSERT INTO staff (company_id, first_name, last_name, role) VALUES ($1, 'Staff', 'Beta', 'Operatore') RETURNING id", [beta]
    )).rows[0].id;
    const vehicleAlfa = (await client.query(
      "INSERT INTO vehicles (company_id, plate, make_model) VALUES ($1, 'TESTALFA1', 'Veicolo Alfa') RETURNING id", [alfa]
    )).rows[0].id;
    const vehicleBeta = (await client.query(
      "INSERT INTO vehicles (company_id, plate, make_model) VALUES ($1, 'TESTBETA1', 'Veicolo Beta') RETURNING id", [beta]
    )).rows[0].id;
    const itemAlfa = (await client.query(
      "INSERT INTO inventory_items (company_id, sku, name, category, quantity) VALUES ($1, 'SKU-ALFA-TEST', 'Articolo Alfa', 'Test', 8) RETURNING id", [alfa]
    )).rows[0].id;
    const itemBeta = (await client.query(
      "INSERT INTO inventory_items (company_id, sku, name, category, quantity) VALUES ($1, 'SKU-BETA-TEST', 'Articolo Beta', 'Test', 9) RETURNING id", [beta]
    )).rows[0].id;
    await client.query(
      "INSERT INTO stock_movements (company_id, item_id, movement_type, quantity, reason) VALUES ($1, $2, 'in', 2, 'Test Alfa'), ($3, $4, 'in', 3, 'Test Beta')",
      [alfa, itemAlfa, beta, itemBeta]
    );
    const taskAlfa = (await client.query(
      "INSERT INTO tasks (company_id, title, status, assigned_to) VALUES ($1, 'Attività Alfa', 'open', $2) RETURNING id", [alfa, staffAlfa]
    )).rows[0].id;
    const taskBeta = (await client.query(
      "INSERT INTO tasks (company_id, title, status, assigned_to) VALUES ($1, 'Attività Beta', 'open', $2) RETURNING id", [beta, staffBeta]
    )).rows[0].id;
    const invoiceAlfa = (await client.query(
      "INSERT INTO invoices (company_id, invoice_number, amount, status) VALUES ($1, 'INV-ALFA-TEST', 100.00, 'issued') RETURNING id", [alfa]
    )).rows[0].id;
    const invoiceBeta = (await client.query(
      "INSERT INTO invoices (company_id, invoice_number, amount, status) VALUES ($1, 'INV-BETA-TEST', 200.00, 'issued') RETURNING id", [beta]
    )).rows[0].id;
    const paymentAlfa = (await client.query(
      "INSERT INTO payments (company_id, invoice_id, amount, method) VALUES ($1, $2, 25.00, 'test') RETURNING id", [alfa, invoiceAlfa]
    )).rows[0].id;
    const paymentBeta = (await client.query(
      "INSERT INTO payments (company_id, invoice_id, amount, method) VALUES ($1, $2, 50.00, 'test') RETURNING id", [beta, invoiceBeta]
    )).rows[0].id;

    async function expectDbFailure(label, sql, values) {
      await client.query('SAVEPOINT expected_constraint_failure');
      let failed = false;
      try {
        await client.query(sql, values);
      } catch (error) {
        failed = true;
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT expected_constraint_failure');
        await client.query('RELEASE SAVEPOINT expected_constraint_failure');
      }
      assert.equal(failed, true, label);
    }

    // Session membership must belong to the same authenticated user.
    const alfaToken = 'alfa-test-session-token-0123456789abcdef';
    const alfaTokenHash = crypto.createHash('sha256').update(alfaToken).digest('hex');
    await client.query(
      'INSERT INTO app_sessions (user_id, token_hash, expires_at, active_membership_id) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\', $3)',
      [alfaUser, alfaTokenHash, alfaMembership]
    );
    await expectDbFailure(
      'A session must not reference another user\'s membership',
      "INSERT INTO app_sessions (user_id, token_hash, expires_at, active_membership_id) VALUES ($1, $2, NOW() + INTERVAL '1 hour', $3)",
      [betaUser, crypto.createHash('sha256').update('beta-invalid-session-token-0123456789').digest('hex'), alfaMembership]
    );

    // The middleware derives tenant identity from the database, and checks revocation live.
    const contextApp = express();
    contextApp.use((req, _res, next) => {
      req.user = { id: alfaUser };
      req.cookies = { fs_session: alfaToken };
      next();
    });
    contextApp.use(createTenantContext(client, value => crypto.createHash('sha256').update(value).digest('hex')));
    contextApp.get('/tenant', (req, res) => res.json({ tenant: req.tenant }));
    const contextServer = await listen(contextApp);
    try {
      const activeContext = await fetch(contextServer.baseUrl + '/tenant');
      assert.equal(activeContext.status, 200, 'An active session and membership must establish tenant context');
      const activeTenant = (await activeContext.json()).tenant;
      assert.equal(activeTenant.companyId, alfa);
      assert.equal(activeTenant.membershipId, alfaMembership);
      assert.equal(activeTenant.role, 'admin');
      await client.query("UPDATE company_memberships SET status = 'revoked' WHERE id = $1", [alfaMembership]);
      const revokedContext = await fetch(contextServer.baseUrl + '/tenant');
      assert.equal(revokedContext.status, 403, 'A revoked membership must lose access on the next request');
      await client.query("UPDATE company_memberships SET status = 'active' WHERE id = $1", [alfaMembership]);
    } finally {
      await new Promise(resolve => contextServer.server.close(resolve));
    }

    // Audit rows must carry a membership that matches both company and user.
    await client.query(
      "INSERT INTO audit_log (user_id, username, action, resource, resource_id, company_id, membership_id) VALUES ($1, 'alfa_test_user', 'tenant.test', 'company', $2, $3, $4)",
      [alfaUser, alfa, alfa, alfaMembership]
    );
    await client.query(
      "INSERT INTO audit_log (user_id, username, action, resource, resource_id, company_id, membership_id) VALUES ($1, 'beta_test_user', 'tenant.test', 'company', $2, $3, $4)",
      [betaUser, beta, beta, betaMembership]
    );
    await expectDbFailure(
      'Audit rows must not mix a company with another company membership',
      "INSERT INTO audit_log (user_id, username, action, resource, resource_id, company_id, membership_id) VALUES ($1, 'alfa_test_user', 'tenant.test', 'company', $2, $3, $4)",
      [alfaUser, beta, beta, alfaMembership]
    );
    await expectDbFailure(
      'Tenant audit context must include company, membership and user together',
      "INSERT INTO audit_log (user_id, username, action, resource, resource_id, company_id, membership_id) VALUES ($1, 'alfa_test_user', 'tenant.test', 'company', $2, $3, NULL)",
      [alfaUser, alfa, alfa]
    );

    // Invitation constraints: normalized address, digest-only token, consistent status timestamps.
    const invitationHash = crypto.createHash('sha256').update('alfa-invitation-token').digest('hex');
    await client.query(
      "INSERT INTO company_invitations (company_id, email, role, token_hash, invited_by_membership_id, expires_at) VALUES ($1, 'nuovo@alfa.example', 'operator', $2, $3, NOW() + INTERVAL '72 hours')",
      [alfa, invitationHash, alfaMembership]
    );
    await expectDbFailure(
      'Only one pending invitation per company and normalized email is allowed',
      "INSERT INTO company_invitations (company_id, email, role, token_hash, invited_by_membership_id, expires_at) VALUES ($1, 'nuovo@alfa.example', 'operator', $2, $3, NOW() + INTERVAL '72 hours')",
      [alfa, crypto.createHash('sha256').update('duplicate-invitation-token').digest('hex'), alfaMembership]
    );
    await expectDbFailure(
      'Invitation token_hash must be a SHA-256 hex digest',
      "INSERT INTO company_invitations (company_id, email, role, token_hash, invited_by_membership_id, expires_at) VALUES ($1, 'hash@alfa.example', 'operator', 'not-a-digest', $2, NOW() + INTERVAL '72 hours')",
      [alfa, alfaMembership]
    );
    await expectDbFailure(
      'Accepted invitation status requires accepted_at',
      "INSERT INTO company_invitations (company_id, email, role, token_hash, invited_by_membership_id, status, expires_at) VALUES ($1, 'accepted@alfa.example', 'operator', $2, $3, 'accepted', NOW() + INTERVAL '72 hours')",
      [alfa, crypto.createHash('sha256').update('accepted-without-time').digest('hex'), alfaMembership]
    );

    function appFor(companyId, membershipId) {
      const app = express();
      app.use(express.json());
      // Test-only identity injection. Production identity comes from verified session membership.
      app.use((req, _res, next) => {
        req.tenant = { companyId, membershipId, role: 'admin' };
        next();
      });
      app.use('/admin', createTenantCustomersCasesRouter(client));
      app.use('/admin', createTenantStaffVehiclesRouter(client));
      app.use('/admin', createTenantInventoryTasksRouter(client));
      app.use('/admin', createTenantInvoicesPaymentsRouter(client));
      app.use('/admin', createTenantDashboardRouter(client));
      app.use('/admin', createTenantAuditRouter(client));
      app.use('/admin', createTenantCompanyAdminRouter(client));
      return app;
    }

    alfaServer = await listen(appFor(alfa, alfaMembership));
    betaServer = await listen(appFor(beta, betaMembership));

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

    async function assertOnlyOwnRecord(server, path, expectedId, idField = 'id') {
      const response = await fetch(server.baseUrl + path);
      assert.equal(response.status, 200, path + ' should be available to tenant admin');
      const payload = await response.json();
      assert.deepEqual(payload.data.map(row => row[idField]), [expectedId], path + ' must expose only this tenant\'s rows');
    }
    await assertOnlyOwnRecord(alfaServer, '/admin/staff', staffAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/staff', staffBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/vehicles', vehicleAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/vehicles', vehicleBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/inventory', itemAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/inventory', itemBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/tasks', taskAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/tasks', taskBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/invoices', invoiceAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/invoices', invoiceBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/inventory/' + itemAlfa + '/movements', (await client.query('SELECT id FROM stock_movements WHERE item_id=$1', [itemAlfa])).rows[0].id);
    await assertOnlyOwnRecord(betaServer, '/admin/inventory/' + itemBeta + '/movements', (await client.query('SELECT id FROM stock_movements WHERE item_id=$1', [itemBeta])).rows[0].id);
    await assertOnlyOwnRecord(alfaServer, '/admin/invoices/' + invoiceAlfa + '/payments', paymentAlfa);
    await assertOnlyOwnRecord(betaServer, '/admin/invoices/' + invoiceBeta + '/payments', paymentBeta);
    await assertOnlyOwnRecord(alfaServer, '/admin/company/members', alfaMembership, 'membershipId');
    await assertOnlyOwnRecord(betaServer, '/admin/company/members', betaMembership, 'membershipId');
    await assertOnlyOwnRecord(alfaServer, '/admin/company/activity', (await client.query('SELECT id FROM audit_log WHERE company_id=$1', [alfa])).rows[0].id);
    await assertOnlyOwnRecord(betaServer, '/admin/company/activity', (await client.query('SELECT id FROM audit_log WHERE company_id=$1', [beta])).rows[0].id);

    const alfaDashboard = await (await fetch(alfaServer.baseUrl + '/admin/dashboard')).json();
    const betaDashboard = await (await fetch(betaServer.baseUrl + '/admin/dashboard')).json();
    assert.equal(alfaDashboard.data.cases.total, 1);
    assert.equal(betaDashboard.data.cases.total, 1);
    assert.equal(alfaDashboard.data.customers.total, 1);
    assert.equal(betaDashboard.data.customers.total, 1);
    assert.equal(Number(alfaDashboard.data.outstandingEuro), 75);
    assert.equal(Number(betaDashboard.data.outstandingEuro), 150);
    const crossTenantMovements = await (await fetch(alfaServer.baseUrl + '/admin/inventory/' + itemBeta + '/movements')).json();
    assert.deepEqual(crossTenantMovements.data, [], 'Alfa must not read Beta stock movements');
    const crossTenantPayments = await (await fetch(alfaServer.baseUrl + '/admin/invoices/' + invoiceBeta + '/payments')).json();
    assert.deepEqual(crossTenantPayments.data, [], 'Alfa must not read Beta invoice payments');

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
      'PASS: Denied write leaves Beta data unchanged.',
      'PASS: Session cannot reference another user membership.',
      'PASS: Tenant context comes from the verified DB membership.',
      'PASS: Membership revocation blocks the next request.',
      'PASS: Audit rows enforce company, membership and user consistency.',
      'PASS: Invitation uniqueness, token digest and status constraints are enforced.',
      'PASS: Staff and vehicles are isolated between Alfa and Beta.',
      'PASS: Inventory, stock movements and tasks are isolated between Alfa and Beta.',
      'PASS: Invoices and payments are isolated between Alfa and Beta.',
      'PASS: Company membership and audit views are scoped to the active tenant.',
      'PASS: Tenant dashboard totals and outstanding balances do not mix companies.',
      'PASS: Cross-tenant stock movement and invoice payment lookups return no data.'
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
