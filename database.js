'use strict';

function splitReturning(sql) {
  const match = /\s+RETURNING\s+([\s\S]+?)\s*;?\s*$/i.exec(sql);
  if (!match) return { sql, projection: null };
  return { sql: sql.slice(0, match.index).trim(), projection: match[1].replace(/;\s*$/, '').trim() };
}

function prepareReturning(sql, projection) {
  if (!projection) return { sql, mode: null, selectSql: null };
  const insert = /^\s*INSERT\s+INTO\s+([\w.]+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i.exec(sql);
  if (insert) {
    const [, table, columns, values] = insert;
    if (/(^|,)\s*id\s*(,|$)/i.test(columns)) {
      throw new Error('MariaDB RETURNING adapter expects generated UUID ids; explicit id inserts need a dedicated query.');
    }
    return {
      sql: \`INSERT INTO \${table} (id, \${columns}) VALUES ((@fs_last_id := UUID()), \${values})\`,
      mode: 'insert',
      selectSql: \`SELECT \${projection} FROM \${table} WHERE id = @fs_last_id\`
    };
  }
  const update = /^\s*UPDATE\s+([\w.]+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(sql);
  if (update) {
    const [, table, , whereClause] = update;
    return { sql, mode: 'update', selectSql: \`SELECT \${projection} FROM \${table} WHERE \${whereClause}\` };
  }
  throw new Error('MariaDB RETURNING non supportato per questa forma SQL: convertire la query esplicitamente.');
}

function rewriteSql(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL query must be a string.');
  const returning = splitReturning(sql);
  let rewritten = returning.sql
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/::\s*int\b/gi, '')
    .replace(/::\s*(?:numeric|varchar|text|date|uuid|timestamptz|bigint|boolean)(?:\s*\([^)]*\))?(?:\[\])?/gi, '');
  // MariaDB 10.11 supports row locks but not PostgreSQL's OF alias list.
  rewritten = rewritten
    .replace(/\s+FOR\s+(SHARE|UPDATE)\s+OF\s+[\w, ]+/gi, (_m, mode) => ' FOR ' + mode)
    .replace(/\s+NULLS\s+LAST\b/gi, ' IS NULL,');
  const prepared = prepareReturning(rewritten, returning.projection);
  const values = [];
  const sqlWithPlaceholders = prepared.sql.replace(/\$(\d+)/g, (_match, index) => {
    const position = Number(index) - 1;
    if (!Number.isInteger(position) || position < 0) throw new Error('Invalid PostgreSQL parameter index.');
    values.push(position);
    return '?';
  });
  const selectSql = prepared.selectSql?.replace(/\$(\d+)/g, '?') || null;
  return { sql: sqlWithPlaceholders, parameterOrder: values, mode: prepared.mode, selectSql };
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
  if (Array.isArray(result)) return { rows: result, rowCount: result.length, command: 'SELECT' };
  return { rows: [], rowCount: Number(result?.affectedRows || 0), command: 'WRITE', insertId: result?.insertId };
}

function normalizeMariaError(error) {
  if (error?.code === 'ER_DUP_ENTRY') error.code = '23505';
  if (error?.code === 'ER_NO_REFERENCED_ROW_2' || error?.code === 'ER_ROW_IS_REFERENCED_2') error.code = '23503';
  return error;
}

function createMariaDbPool(env = process.env) {
  const mysql = require('mysql2/promise');
  const required = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error('Configurazione MariaDB incompleta: ' + missing.join(', '));
  const pool = mysql.createPool({
    host: env.MARIADB_HOST, port: Number(env.MARIADB_PORT || 3306),
    user: env.MARIADB_USER, password: env.MARIADB_PASSWORD, database: env.MARIADB_DATABASE,
    charset: 'utf8mb4', waitForConnections: true,
    connectionLimit: Number(env.MARIADB_CONNECTION_LIMIT || 10), queueLimit: 0,
    enableKeepAlive: true, dateStrings: false, decimalNumbers: true
  });

  async function run(target, sql, params) {
    const converted = rewriteSql(sql);
    const ordered = reorderParams(params, converted.parameterOrder);
    let connection = target;
    let owned = false;
    if (converted.mode && typeof target.getConnection === 'function') {
      connection = await target.getConnection();
      owned = true;
    }
    try {
      const [result] = await connection.execute(converted.sql, ordered);
      if (converted.mode === 'insert') {
        const [rows] = await connection.query(converted.selectSql);
        return { rows, rowCount: rows.length, command: 'INSERT' };
      }
      if (converted.mode === 'update') {
        const whereCount = (converted.selectSql.match(/\?/g) || []).length;
        const [rows] = await connection.execute(converted.selectSql, ordered.slice(ordered.length - whereCount));
        return { rows, rowCount: rows.length, command: 'UPDATE' };
      }
      return normalizeResult(result);
    } catch (error) {
      throw normalizeMariaError(error);
    } finally {
      if (owned) connection.release();
    }
  }

  return {
    dialect: 'mariadb',
    query(sql, params = []) { return run(pool, sql, params); },
    async connect() {
      const connection = await pool.getConnection();
      return {
        query(sql, params = []) { return run(connection, sql, params); },
        release() { connection.release(); },
        end() { connection.release(); }
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
    return new Pool({ connectionString: env.DATABASE_URL, ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  }
  throw new Error('DB_DIALECT non supportato. Valori ammessi: postgres, mariadb.');
}

module.exports = { createDatabasePool, createMariaDbPool, rewriteSql, reorderParams, normalizeResult, normalizeMariaError };
