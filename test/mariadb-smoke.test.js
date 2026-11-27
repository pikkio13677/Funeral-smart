'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
