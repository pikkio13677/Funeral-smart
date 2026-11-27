'use strict';

function rewriteSql(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL query must be a string.');
  // The current MariaDB schema uses a case-insensitive utf8mb4 collation.
  // LIKE therefore preserves the intended case-insensitive search behavior.
  let rewritten = sql.replace(/\bILIKE\b/gi, 'LIKE');
  rewritten = rewritten.replace(/::\s*int\b/gi, ''); // COUNT(*)::int is numeric already in MariaDB.
  const values = [];
  rewritten = rewritten.replace(/\$(\d+)/g, (_match, index) => {
    const position = Number(index) - 1;
    if (!Number.isInteger(position) || position < 0) throw new Error('Invalid PostgreSQL parameter index.');
    values.push(position);
    return '?';
  });
  return { sql: rewritten, parameterOrder: values };
}

function reorderParams(params, order) {
  if (!order.length) return params || [];
  if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array.');
  return order.map(index => {
    if (index >= params.length) throw new Error('SQL references a missing parameter.');
    return params[index];
  });
}

function normalizeResult(result) {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length, command: 'SELECT' };
  }
  return {
    rows: [],
    rowCount: Number(result?.affectedRows || 0),
    command: 'WRITE',
    insertId: result?.insertId
  };
}

function createMariaDbPool(env = process.env) {
  const mysql = require('mysql2/promise');
  const required = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error('Configurazione MariaDB incompleta: ' + missing.join(', '));

  const pool = mysql.createPool({
    host: env.MARIADB_HOST,
    port: Number(env.MARIADB_PORT || 3306),
    user: env.MARIADB_USER,
    password: env.MARIADB_PASSWORD,
    database: env.MARIADB_DATABASE,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(env.MARIADB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    enableKeepAlive: true,
    dateStrings: false,
    decimalNumbers: true
  });

  async function run(target, sql, params) {
    const converted = rewriteSql(sql);
    const ordered = reorderParams(params, converted.parameterOrder);
    const [result] = await target.execute(converted.sql, ordered);
    return normalizeResult(result);
  }

  return {
    dialect: 'mariadb',
    query(sql, params = []) { return run(pool, sql, params); },
    async connect() {
      const connection = await pool.getConnection();
      return {
        query(sql, params = []) { return run(connection, sql, params); },
        async release() { connection.release(); },
        async end() { connection.release(); }
      };
    },
    async end() { await pool.end(); }
  };
}

function createDatabasePool(env = process.env) {
  const dialect = String(env.DB_DIALECT || 'postgres').toLowerCase();
  if (dialect === 'mariadb' || dialect === 'mysql') return createMariaDbPool(env);
  if (dialect === 'postgres' || dialect === 'postgresql') {
    const { Pool } = require('pg');
    return new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    });
  }
  throw new Error('DB_DIALECT non supportato. Valori ammessi: postgres, mariadb.');
}

module.exports = { createDatabasePool, createMariaDbPool, rewriteSql, reorderParams, normalizeResult };
