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

    process.stdout.write('MariaDB 10.11 schema, repeatable service seed, provider link and price-list FK checks passed.\n');
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
