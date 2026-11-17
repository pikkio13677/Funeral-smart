'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

const migrationFiles = [
  '005_multi_tenant_foundation.draft.sql',
  '006_session_active_membership.draft.sql',
  '007_audit_invitations.draft.sql',
  '008_tenant_composite_foreign_keys.draft.sql',
  '009_platform_access.draft.sql',
  '010_platform_owner_bootstrap.draft.sql',
  '011_platform_audit_log.draft.sql'
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
      ['platform_access', 'platform_access'],
      ['platform_bootstrap_state', 'platform_bootstrap_state'],
      ['platform_audit_log', 'platform_audit_log'],
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

    const ownerRoleConstraint = await client.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'app_users_role_check' AND pg_get_constraintdef(oid) LIKE '%platform_owner%'"
    );
    if (!ownerRoleConstraint.rowCount) throw new Error('Platform owner app_users role constraint missing.');

    const bootstrapState = await client.query(
      'SELECT singleton, consumed_at FROM platform_bootstrap_state WHERE singleton = TRUE'
    );
    if (bootstrapState.rowCount !== 1 || bootstrapState.rows[0].consumed_at !== null) {
      throw new Error('Platform bootstrap state must contain one unused singleton row in the disposable database.');
    }

    const ownerIndex = await client.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_platform_access_single_active_owner'"
    );
    if (!ownerIndex.rowCount) throw new Error('Single active platform owner index missing.');

    const compositeConstraints = [
      'fk_funeral_cases_tenant_customer',
      'fk_stock_movements_tenant_item',
      'fk_stock_movements_tenant_case',
      'fk_tasks_tenant_case',
      'fk_tasks_tenant_staff',
      'fk_invoices_tenant_case',
      'fk_invoices_tenant_customer',
      'fk_payments_tenant_invoice'
    ];
    for (const name of compositeConstraints) {
      const result = await client.query(
        'SELECT 1 FROM pg_constraint WHERE conname = $1 AND contype = $2',
        [name, 'f']
      );
      if (!result.rowCount) throw new Error('Expected tenant composite foreign key missing: ' + name);
    }

    process.stdout.write('All draft tenant migrations and composite foreign keys verified on disposable PostgreSQL.\\n');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
