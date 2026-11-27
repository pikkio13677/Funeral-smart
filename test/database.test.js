'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteSql, reorderParams, normalizeResult, normalizeMariaError } = require('../database');

test('converte placeholder PostgreSQL nell’ordine dei parametri MariaDB', () => {
  const converted = rewriteSql('SELECT * FROM inquiries WHERE city=$2 AND status=$1 AND id=$2');
  assert.equal(converted.sql, 'SELECT * FROM inquiries WHERE city=? AND status=? AND id=?');
  assert.deepEqual(reorderParams(['received', 'Torino'], converted.parameterOrder), ['Torino', 'received', 'Torino']);
});

test('converte ILIKE e cast PostgreSQL semplici', () => {
  const converted = rewriteSql('SELECT COUNT(*)::int AS total FROM companies WHERE name ILIKE $1::varchar');
  assert.equal(converted.sql, 'SELECT COUNT(*) AS total FROM companies WHERE name LIKE ?');
});

test('traduce INSERT RETURNING con UUID generato sulla stessa connessione', () => {
  const converted = rewriteSql('INSERT INTO customers(first_name,last_name) VALUES($1,$2) RETURNING id,first_name AS "firstName"');
  assert.equal(converted.sql, 'INSERT INTO customers (id, first_name,last_name) VALUES ((@fs_last_id := UUID()), ?,?)');
  assert.equal(converted.selectSql, 'SELECT id,first_name AS "firstName" FROM customers WHERE id = @fs_last_id');
  assert.equal(converted.mode, 'insert');
  assert.deepEqual(reorderParams(['Ada', 'Lovelace'], converted.parameterOrder), ['Ada', 'Lovelace']);
});

test('traduce UPDATE RETURNING e conserva i parametri del WHERE', () => {
  const converted = rewriteSql('UPDATE app_users SET active=$1 WHERE id=$2 RETURNING id,username,active');
  assert.equal(converted.sql, 'UPDATE app_users SET active=? WHERE id=?');
  assert.equal(converted.selectSql, 'SELECT id,username,active FROM app_users WHERE id=?');
  assert.equal(converted.mode, 'update');
  assert.deepEqual(reorderParams([false, 'user-id'], converted.parameterOrder).slice(-1), ['user-id']);
});

test('adatta blocchi di lock e ordinamento NULLS LAST', () => {
  assert.equal(rewriteSql('SELECT id FROM items FOR UPDATE OF items').sql, 'SELECT id FROM items FOR UPDATE');
  assert.equal(rewriteSql('SELECT id FROM tasks ORDER BY due_date NULLS LAST').sql, 'SELECT id FROM tasks ORDER BY due_date IS NULL, due_date');
});

test('normalizza righe, risultati di scrittura ed errori MariaDB', () => {
  assert.deepEqual(normalizeResult([{ id: 'x' }]), { rows: [{ id: 'x' }], rowCount: 1, command: 'SELECT' });
  assert.deepEqual(normalizeResult({ affectedRows: 2, insertId: 7 }), { rows: [], rowCount: 2, command: 'WRITE', insertId: 7 });
  const duplicate = { code: 'ER_DUP_ENTRY' };
  assert.equal(normalizeMariaError(duplicate).code, '23505');
});

test('rifiuta parametri mancanti e forme RETURNING non supportate', () => {
  assert.throws(() => reorderParams([], [1]), /missing parameter/);
  assert.throws(() => rewriteSql('DELETE FROM customers WHERE id=$1 RETURNING id'), /RETURNING non supportato/);
});
