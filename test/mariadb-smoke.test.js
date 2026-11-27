'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { createDatabasePool } = require('../database');

const enabled = Boolean(process.env.MARIADB_HOST);

test('MariaDB 10.11 loads the base schema and supports the application adapter', { skip: !enabled }, async () => {
  const connection = await mysql.createConnection({
    host: process.env.MARIADB_HOST,
    port: Number(process.env.MARIADB_PORT || 3306),
    user: process.env.MARIADB_USER,
    password: process.env.MARIADB_PASSWORD,
    database: process.env.MARIADB_DATABASE,
    multipleStatements: false
  });
  const pool = createDatabasePool({ ...process.env, DB_DIALECT: 'mariadb' });

  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.mariadb.sql'), 'utf8');
    const statements = schema
      .split(/;\s*(?:\r?\n|$)/)
      .map(statement => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await connection.query(statement);
    }

    const [tables] = await connection.query(
      'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    assert.ok(Number(tables[0].total) >= 22, 'base schema tables should all exist');

    const bootstrapEnv = {
      ...process.env,
      NODE_ENV: 'test',
      MARIADB_SCHEMA_SETUP_APPROVED: 'true'
    };
    const bootstrapScript = path.join(__dirname, '..', 'migrate-mariadb.js');
    const blockedBootstrap = spawnSync(process.execPath, [bootstrapScript], {
      env: bootstrapEnv,
      encoding: 'utf8'
    });
    assert.equal(blockedBootstrap.status, 1);
    assert.match(blockedBootstrap.stderr, /database non è vuoto/);

    await connection.execute(
      'INSERT INTO schema_migrations(id) VALUES (?)',
      ['001_mariadb_base_and_gestionale']
    );
    const repeatedBootstrap = spawnSync(process.execPath, [bootstrapScript], {
      env: bootstrapEnv,
      encoding: 'utf8'
    });
    assert.equal(repeatedBootstrap.status, 0, repeatedBootstrap.stderr);
    assert.match(repeatedBootstrap.stdout, /già registrato/);

    const inserted = await pool.query(
      'INSERT INTO customers(first_name,last_name) VALUES($1,$2) RETURNING id,first_name AS "firstName"',
      ['MariaDB', 'SmokeTest']
    );
    assert.equal(inserted.rowCount, 1);
    assert.equal(inserted.rows[0].firstName, 'MariaDB');
    const customerId = inserted.rows[0].id;

    const updated = await pool.query(
      'UPDATE customers SET last_name=$1 WHERE id=$2 RETURNING id,last_name',
      ['Updated', customerId]
    );
    assert.equal(updated.rowCount, 1);
    assert.equal(updated.rows[0].last_name, 'Updated');

    const count = await pool.query('SELECT COUNT(*)::int AS total FROM customers');
    assert.equal(Number(count.rows[0].total), 1);

    const provider = await pool.query(
      'INSERT INTO providers(business_name,vat_number,city) VALUES($1,$2,$3) RETURNING id',
      ['Impresa MariaDB Smoke', 'ITSMOKE' + Date.now(), 'Torino']
    );
    const providerSearch = await pool.query(
      'SELECT id FROM providers WHERE city ILIKE $1',
      ['%torino%']
    );
    assert.equal(providerSearch.rowCount, 1);
    assert.equal(providerSearch.rows[0].id, provider.rows[0].id);

    await pool.query('INSERT INTO tasks(title,due_date) VALUES($1,$2)', ['Attività smoke', null]);
    const orderedTasks = await pool.query(
      'SELECT id FROM tasks ORDER BY due_date NULLS LAST LIMIT 1'
    );
    assert.equal(orderedTasks.rowCount, 1);

    const user = await pool.query(
      "INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id,username",
      ['maria-smoke-' + Date.now(), 'MariaDB Smoke', 'test-hash']
    );
    assert.equal(user.rowCount, 1);

    await pool.query(
      'INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,DATE_ADD(NOW(), INTERVAL $3 DAY))',
      [user.rows[0].id, 'a'.repeat(64), 8]
    );

    const hashes = ['hash-one', 'hash-two'];
    await pool.query(
      'UPDATE app_users SET recovery_codes_hashes=$1::jsonb WHERE id=$2',
      [JSON.stringify(hashes), user.rows[0].id]
    );
    await pool.query(
      "UPDATE app_users SET recovery_codes_hashes = CASE WHEN JSON_SEARCH(recovery_codes_hashes, 'one', $1) IS NULL THEN recovery_codes_hashes ELSE JSON_REMOVE(recovery_codes_hashes, JSON_UNQUOTE(JSON_SEARCH(recovery_codes_hashes, 'one', $1))) END WHERE id=$2",
      ['hash-one', user.rows[0].id]
    );

    const stored = await pool.query(
      'SELECT recovery_codes_hashes FROM app_users WHERE id=$1',
      [user.rows[0].id]
    );
    const recoveryHashes = stored.rows[0].recovery_codes_hashes;
    assert.deepEqual(Array.isArray(recoveryHashes) ? recoveryHashes : JSON.parse(recoveryHashes), ['hash-two']);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT id FROM customers WHERE id=$1 FOR SHARE', [customerId]);
      assert.equal(locked.rowCount, 1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await connection.end();
  }
});
