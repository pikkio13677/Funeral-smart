'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const createMariaDbDatabase = require('../provider-portal-mariadb/database');

const scrypt = promisify(crypto.scrypt);

function assertBootstrapEnvironment(env) {
  if (env.FUNERAL_SMART_ENV !== 'staging') throw new Error('Bootstrap consentito solo con FUNERAL_SMART_ENV=staging.');
  if (!env.MARIADB_DATABASE || env.MARIADB_DATABASE !== env.MARIADB_STAGING_DATABASE) {
    throw new Error('Bootstrap bloccato: database MariaDB non identificato come staging.');
  }
  if (env.STAGING_BOOTSTRAP_CONFIRM !== 'CREATE_FIRST_STAGING_ADMIN') {
    throw new Error('Conferma bootstrap mancante.');
  }
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(env.STAGING_BOOTSTRAP_USERNAME || '')) {
    throw new Error('STAGING_BOOTSTRAP_USERNAME non valido.');
  }
  if (typeof env.STAGING_BOOTSTRAP_DISPLAY_NAME !== 'string' || env.STAGING_BOOTSTRAP_DISPLAY_NAME.trim().length < 2 ||
      env.STAGING_BOOTSTRAP_DISPLAY_NAME.trim().length > 160) {
    throw new Error('STAGING_BOOTSTRAP_DISPLAY_NAME non valido.');
  }
  if (typeof env.STAGING_BOOTSTRAP_PASSWORD !== 'string' || env.STAGING_BOOTSTRAP_PASSWORD.length < 12 ||
      env.STAGING_BOOTSTRAP_PASSWORD.length > 200) {
    throw new Error('STAGING_BOOTSTRAP_PASSWORD deve contenere 12–200 caratteri.');
  }
}

async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

async function bootstrap(env = process.env) {
  assertBootstrapEnvironment(env);
  const database = createMariaDbDatabase({ env });
  let connection;
  let lockAcquired = false;
  try {
    connection = await database.pool.getConnection();
    const [locks] = await connection.query("SELECT GET_LOCK('funeral_smart_mariadb_staging_admin_bootstrap', 10) AS acquired");
    lockAcquired = Number(locks[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error('Impossibile ottenere il blocco esclusivo per il bootstrap.');
    const [existing] = await connection.execute("SELECT id FROM app_users WHERE role IN ('admin','platform_owner') LIMIT 1");
    if (existing.length) throw new Error('Esiste già un amministratore piattaforma. Bootstrap rifiutato.');
    const passwordHash = await makePasswordHash(env.STAGING_BOOTSTRAP_PASSWORD);
    await connection.execute(
      "INSERT INTO app_users (id, username, display_name, password_hash, role, active, created_at, updated_at) VALUES (UUID(), ?, ?, ?, 'admin', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [env.STAGING_BOOTSTRAP_USERNAME.toLowerCase(), env.STAGING_BOOTSTRAP_DISPLAY_NAME.trim(), passwordHash]
    );
    process.stdout.write('Account amministratore staging creato. Rimuovere subito le variabili STAGING_BOOTSTRAP_* dall’ambiente.\\n');
  } finally {
    if (connection) {
      if (lockAcquired) {
        try { await connection.query("SELECT RELEASE_LOCK('funeral_smart_mariadb_staging_admin_bootstrap')"); } catch (_) {}
      }
      connection.release();
    }
    await database.close();
  }
}

if (require.main === module) {
  bootstrap().catch(error => {
    process.stderr.write('Bootstrap staging non eseguito: ' + error.message + '\\n');
    process.exitCode = 1;
  });
}

module.exports = { assertBootstrapEnvironment, bootstrap, makePasswordHash };
