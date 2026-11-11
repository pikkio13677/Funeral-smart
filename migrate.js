'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

const migrations = [
  { id: '001_base_schema', file: 'schema.sql' },
  { id: '002_gestionale_v1', file: 'gestionale.sql' }
];

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL non configurata: migrazioni non eseguite.');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined
  });

  await client.connect();
  let lockAcquired = false;

  try {
    // Evita che due avvii simultanei applichino la stessa migrazione.
    await client.query('SELECT pg_advisory_lock(741902, 1)');
    lockAcquired = true;

    await client.query(
      'CREATE TABLE IF NOT EXISTS public.schema_migrations (' +
      'id VARCHAR(120) PRIMARY KEY, ' +
      'applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );

    for (const migration of migrations) {
      const existing = await client.query(
        'SELECT id FROM public.schema_migrations WHERE id = $1',
        [migration.id]
      );

      if (existing.rowCount > 0) {
        console.log('Migrazione già applicata: ' + migration.id);
        continue;
      }

      const sql = await fs.readFile(
        path.join(__dirname, migration.file),
        'utf8'
      );

      console.log('Avvio migrazione: ' + migration.id);
      await client.query('BEGIN');

      try {
        // Ogni file SQL viene applicato una sola volta in una transazione.
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (id) VALUES ($1)',
          [migration.id]
        );
        await client.query('COMMIT');
        console.log('Migrazione completata: ' + migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('Migrazioni database completate.');
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(741902, 1)');
      } catch (_error) {
        console.error('Avviso: impossibile rilasciare il lock delle migrazioni.');
      }
    }
    await client.end();
  }
}

runMigrations().catch(error => {
  console.error('ERRORE MIGRAZIONI DATABASE:', error.message);
  process.exitCode = 1;
});
