'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

const migrationFiles = [
  '005_multi_tenant_foundation.draft.sql',
  '006_session_active_membership.draft.sql',
  '007_audit_invitations.draft.sql'
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for draft migration integration checks.');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });

  await client.connect();
  try {
    for (const file of migrationFiles) {
      const sql = await fs.readFile(path.join(__dirname, '..', 'migrations', file), 'utf8');
      if (/^\s*(BEGIN|COMMIT)\s*;/im.test(sql)) {
        throw new Error(file + ' must not manage transactions; migrate.js/test runner owns them.');
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        process.stdout.write('Draft migration OK: ' + file + '\n');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(file + ' failed: ' + error.message);
      }
    }

    const checks = [
      ['companies', 'companies'],
      ['company_memberships', 'company_memberships'],
      ['company_invitations', 'company_invitations'],
      ['customers.company_id', 'customers'],
      ['funeral_cases.company_id', 'funeral_cases'],
      ['staff.company_id', 'staff'],
      ['vehicles.company_id', 'vehicles'],
      ['inventory_items.company_id', 'inventory_items'],
      ['stock_movements.company_id', 'stock_movements'],
      ['tasks.company_id', 'tasks'],
      ['invoices.company_id', 'invoices'],
      ['payments.company_id', 'payments'],
      ['app_sessions.active_membership_id', 'app_sessions'],
      ['app_users.email', 'app_users'],
      ['app_users.email_verified_at', 'app_users'],
      ['audit_log.company_id', 'audit_log'],
      ['audit_log.membership_id', 'audit_log']
    ];

    for (const [label, table] of checks) {
      const column = label.includes('.') ? label.split('.')[1] : null;
      const result = column
        ? await client.query(
            'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
            ['public', table, column]
          )
        : await client.query(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
            ['public', table]
          );
      if (!result.rowCount) throw new Error('Expected database object missing: ' + label);
    }

    process.stdout.write('All draft tenant migrations applied and expected objects verified on disposable PostgreSQL.\n');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
