'use strict';

// Manual-only MariaDB schema bootstrap. This script is deliberately NOT wired
// into npm start and refuses to run unless the operator explicitly opts in.
require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  if (process.env.MARIADB_SCHEMA_SETUP_APPROVED !== 'true') {
    throw new Error('Bloccato: impostare MARIADB_SCHEMA_SETUP_APPROVED=true solo dopo aver verificato che il database sia uno staging vuoto.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Bloccato: il bootstrap dello schema non è consentito con NODE_ENV=production.');
  }

  const required = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error('Configurazione MariaDB incompleta: ' + missing.join(', '));

  const connection = await mysql.createConnection({
    host: process.env.MARIADB_HOST,
    port: Number(process.env.MARIADB_PORT || 3306),
    user: process.env.MARIADB_USER,
    password: process.env.MARIADB_PASSWORD,
    database: process.env.MARIADB_DATABASE,
    charset: 'utf8mb4',
    multipleStatements: false,
    connectTimeout: 10000
  });

  try {
    const [identity] = await connection.query('SELECT DATABASE() AS databaseName, VERSION() AS serverVersion');
    if (!identity[0]?.databaseName) throw new Error('Il server non ha selezionato un database.');
    console.log('Database selezionato:', identity[0].databaseName);
    console.log('Versione server:', identity[0].serverVersion);

    const sql = await fs.readFile(path.join(__dirname, 'schema.mariadb.sql'), 'utf8');
    const statements = sql
      .split(/;\\s*(?:\\r?\\n|$)/)
      .map(statement => statement.trim())
      .filter(Boolean);

    for (let index = 0; index < statements.length; index += 1) {
      await connection.query(statements[index]);
    }

    await connection.execute(
      'INSERT INTO schema_migrations (id) VALUES (?) ON DUPLICATE KEY UPDATE id = VALUES(id)',
      ['001_mariadb_base_and_gestionale']
    );
    console.log('Schema MariaDB iniziale applicato.');
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error('BOOTSTRAP MARIA DB NON COMPLETATO:', error.message);
  process.exitCode = 1;
});
