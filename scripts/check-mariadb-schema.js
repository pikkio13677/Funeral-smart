'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const required = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_DATABASE'];
  for (const name of required) {
    if (!process.env[name]) throw new Error(name + ' is required for disposable MariaDB schema checks.');
  }

  const connection = await mysql.createConnection({
    host: process.env.MARIADB_HOST,
    port: Number(process.env.MARIADB_PORT || 3306),
    user: process.env.MARIADB_USER,
    password: process.env.MARIADB_PASSWORD || '',
    database: process.env.MARIADB_DATABASE,
    multipleStatements: true,
    timezone: 'Z'
  });

  try {
    const schema = await fs.readFile(
      path.join(__dirname, '..', 'mariadb', 'schema-provider-portal.sql'),
      'utf8'
    );

    // Apply twice to verify CREATE IF NOT EXISTS and the service seed are repeatable.
    await connection.query(schema);
    await connection.query(schema);

    const [tables] = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    const tableNames = new Set(tables.map(row => row.TABLE_NAME || row.table_name));
    for (const name of [
      'service_types', 'providers', 'provider_services', 'price_lists', 'inquiries',
      'inquiry_provider_assignments', 'provider_user_access',
      'provider_user_invitations', 'provider_inquiry_responses',
      'provider_portal_audit_log'
    ]) {
      assert.ok(tableNames.has(name), 'Missing MariaDB table: ' + name);
    }

    const [services] = await connection.execute(
      'SELECT id, label FROM service_types WHERE code = ?',
      ['cremation-burial']
    );
    assert.equal(services.length, 1, 'Combined service seed must exist exactly once.');
    assert.equal(services[0].label, 'Cremazione + Sepoltura');

    // Exercise the real MariaDB foreign-key path used by provider services and price lists.
    const providerId = crypto.randomUUID();
    await connection.execute(
      "INSERT INTO providers (id, business_name, vat_number, city, status, verification_date) VALUES (?, ?, ?, ?, 'verified', UTC_TIMESTAMP(3))",
      [providerId, 'CI Impresa Temporanea', 'CI' + crypto.randomBytes(7).toString('hex').toUpperCase(), 'Torino']
    );
    await connection.execute(
      'INSERT INTO provider_services (provider_id, service_type_id) VALUES (?, ?)',
      [providerId, services[0].id]
    );
    await connection.execute(
      "INSERT INTO price_lists (id, provider_id, service_type_id, title, total_euro, included_items, excluded_items, published) VALUES (?, ?, ?, ?, NULL, ?, ?, 0)",
      [crypto.randomUUID(), providerId, services[0].id, 'CI Cremazione + Sepoltura', JSON.stringify([]), JSON.stringify([])]
    );

    const [linked] = await connection.execute(
      'SELECT st.code, st.label FROM provider_services ps JOIN service_types st ON st.id = ps.service_type_id JOIN price_lists pl ON pl.provider_id = ps.provider_id AND pl.service_type_id = st.id WHERE ps.provider_id = ?',
      [providerId]
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0].code, 'cremation-burial');

    // Exercise one-active-assignment uniqueness and history release on the real MariaDB engine.
    const userId = crypto.randomUUID();
    const inquiryId = crypto.randomUUID();
    await connection.execute(
      "INSERT INTO app_users (id, username, display_name, password_hash, role, active) VALUES (?, ?, ?, ?, 'platform_owner', 1)",
      [userId, 'ci_' + crypto.randomBytes(5).toString('hex'), 'CI Platform Owner', 'ci-only-password-hash']
    );
    await connection.execute(
      "INSERT INTO inquiries (id, city, service_type, contact_phone, privacy_consent, status) VALUES (?, 'Torino', 'Cremazione + Sepoltura', '+390110000000', 1, 'received')",
      [inquiryId]
    );
    const firstAssignment = crypto.randomUUID();
    await connection.execute(
      "INSERT INTO inquiry_provider_assignments (id, inquiry_id, provider_id, assigned_by_user_id, status, active_inquiry_id) VALUES (?, ?, ?, ?, 'active', ?)",
      [firstAssignment, inquiryId, providerId, userId, inquiryId]
    );
    const [activeAssignment] = await connection.execute(
      "SELECT id FROM inquiry_provider_assignments WHERE active_inquiry_id = ? AND status = 'active'",
      [inquiryId]
    );
    assert.equal(activeAssignment.length, 1);
    await assert.rejects(
      connection.execute(
        "INSERT INTO inquiry_provider_assignments (id, inquiry_id, provider_id, assigned_by_user_id, status, active_inquiry_id) VALUES (?, ?, ?, ?, 'active', ?)",
        [crypto.randomUUID(), inquiryId, providerId, userId, inquiryId]
      ),
      error => error && error.code === 'ER_DUP_ENTRY'
    );
    await connection.execute(
      "UPDATE inquiry_provider_assignments SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3), revoked_by_user_id = ?, revocation_reason = ?, active_inquiry_id = NULL WHERE id = ? AND status = 'active'",
      [userId, 'Test CI di revoca assegnazione e rilascio vincolo.', firstAssignment]
    );
    const [released] = await connection.execute(
      'SELECT id, status, active_inquiry_id FROM inquiry_provider_assignments WHERE id = ?',
      [firstAssignment]
    );
    assert.equal(released[0].status, 'revoked');
    assert.equal(released[0].active_inquiry_id, null);
    const secondAssignment = crypto.randomUUID();
    await connection.execute(
      "INSERT INTO inquiry_provider_assignments (id, inquiry_id, provider_id, assigned_by_user_id, status, active_inquiry_id) VALUES (?, ?, ?, ?, 'active', ?)",
      [secondAssignment, inquiryId, providerId, userId, inquiryId]
    );

    process.stdout.write('MariaDB 10.11 schema, repeatable service seed, provider link and price-list FK checks passed.\n');
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
