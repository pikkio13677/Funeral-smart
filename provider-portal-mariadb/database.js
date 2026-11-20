'use strict';

/**
 * MariaDB connection boundary for the isolated provider-portal port.
 * This module is deliberately not wired into the production server yet.
 * Credentials are read only from the process environment and are never logged.
 */
function createMariaDbDatabase({ env = process.env, mysql } = {}) {
  const required = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'];
  const missing = required.filter(key => typeof env[key] !== 'string' || env[key].length === 0);
  if (missing.length) {
    throw new Error('Configurazione MariaDB incompleta: ' + missing.join(', '));
  }

  const driver = mysql || require('mysql2/promise');
  if (!driver || typeof driver.createPool !== 'function') {
    throw new TypeError('Driver mysql2/promise non valido.');
  }

  const pool = driver.createPool({
    host: env.MARIADB_HOST,
    port: Number(env.MARIADB_PORT || 3306),
    user: env.MARIADB_USER,
    password: env.MARIADB_PASSWORD,
    database: env.MARIADB_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(env.MARIADB_CONNECTION_LIMIT || 5),
    queueLimit: 0,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: false,
    charset: 'utf8mb4'
  });

  return Object.freeze({
    pool,
    query(sql, values = []) {
      return pool.execute(sql, values);
    },
    async ping() {
      await pool.query('SELECT 1 AS ok');
      return true;
    },
    async withTransaction(work) {
      if (typeof work !== 'function') throw new TypeError('La transazione richiede una funzione.');
      const connection = await pool.getConnection();
      let began = false;
      try {
        await connection.beginTransaction();
        began = true;
        const result = await work(connection);
        await connection.commit();
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try { await connection.rollback(); } catch (_) { /* preserve original error */ }
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    close() {
      return pool.end();
    }
  });
}

module.exports = createMariaDbDatabase;
