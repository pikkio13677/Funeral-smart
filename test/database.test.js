'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteSql, reorderParams, normalizeResult } = require('../database');

test('converte i placeholder PostgreSQL nell’ordine dei parametri MariaDB', () => {
  const converted = rewriteSql('SELECT * FROM inquiries WHERE city=$2 AND status=$1 AND id=$2');
  assert.equal(converted.sql, 'SELECT * FROM inquiries WHERE city=? AND status=? AND id=?');
  assert.deepEqual(reorderParams(['received', 'Torino'], converted.parameterOrder), ['Torino', 'received', 'Torino']);
});

test('converte ILIKE in LIKE per la collation MariaDB case-insensitive', () => {
  assert.equal(rewriteSql('city ILIKE $1').sql, 'city LIKE ?');
});

test('normalizza righe e risultati di scrittura nello shape usato dalle route', () => {
  assert.deepEqual(normalizeResult([{ id: 'x' }]), { rows: [{ id: 'x' }], rowCount: 1, command: 'SELECT' });
  assert.deepEqual(normalizeResult({ affectedRows: 2, insertId: 7 }), {
    rows: [], rowCount: 2, command: 'WRITE', insertId: 7
  });
});

test('rifiuta parametri mancanti', () => {
  assert.throws(() => reorderParams([], [1]), /missing parameter/);
});
