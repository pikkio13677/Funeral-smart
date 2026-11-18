'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');
const crypto = require('node:crypto');
const { backfillSingleCompany } = require('./backfill-single-company');

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

    // Rehearse the one-company legacy backfill on disposable PostgreSQL.
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    await client.query(
      "INSERT INTO companies(id,legal_name,status,plan_code) VALUES($1,$2,'active','trial')",
      [companyId, 'Single Company Backfill Test ' + suffix]
    );
    await client.query(
      "INSERT INTO app_users(id,username,display_name,password_hash,role,active) VALUES($1,$2,$3,$4,'admin',TRUE)",
      [userId, 'single_backfill_' + suffix, 'Single Company Test', 'test-only-not-a-real-password-hash']
    );
    await client.query(
      'INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'1 day\')',
      [userId, crypto.randomBytes(32).toString('hex')]
    );
    const dryRunReport = await backfillSingleCompany(client, companyId, { apply: false });
    if (dryRunReport.membershipsToCreate !== 1) {
      throw new Error('Single-company backfill dry-run did not identify the expected membership.');
    }
    const dryRunMembershipCheck = await client.query(
      'SELECT 1 FROM company_memberships WHERE company_id=$1 AND user_id=$2',
      [companyId, userId]
    );
    if (dryRunMembershipCheck.rowCount) throw new Error('Single-company dry-run changed membership data.');

    const backfillReport = await backfillSingleCompany(client, companyId, { apply: true });
    if (backfillReport.membershipsCreated !== 1) {
      throw new Error('Single-company backfill did not create the expected initial admin membership.');
    }
    const membershipCheck = await client.query(
      "SELECT 1 FROM company_memberships WHERE company_id=$1 AND user_id=$2 AND role='admin' AND status='active'",
      [companyId, userId]
    );
    if (!membershipCheck.rowCount) throw new Error('Single-company backfill membership verification failed.');

    const sessionCheck = await client.query(
      'SELECT 1 FROM app_sessions s JOIN company_memberships m ON m.id=s.active_membership_id AND m.user_id=s.user_id WHERE s.user_id=$1 AND m.company_id=$2',
      [userId, companyId]
    );
    if (!sessionCheck.rowCount) throw new Error('Single-company backfill did not link the existing session to its membership.');

    const finalizationSql = await fs.readFile(
      path.join(__dirname, '..', 'migrations', '012_tenant_finalize_company_id.draft.sql'),
      'utf8'
    );
    await client.query('BEGIN');
    try {
      await client.query(finalizationSql);
      await client.query('COMMIT');
      process.stdout.write('Draft migration OK: 012_tenant_finalize_company_id.draft.sql after single-company backfill\n');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error('012_tenant_finalize_company_id.draft.sql failed after backfill: ' + error.message);
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

    const companyForeignKeys = [
      'customers_company_id_fkey',
      'funeral_cases_company_id_fkey',
      'staff_company_id_fkey',
      'vehicles_company_id_fkey',
      'inventory_items_company_id_fkey',
      'stock_movements_company_id_fkey',
      'tasks_company_id_fkey',
      'invoices_company_id_fkey',
      'payments_company_id_fkey'
    ];
    for (const name of companyForeignKeys) {
      const result = await client.query(
        "SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE c.conname=$1 AND c.contype='f' AND c.convalidated AND n.nspname='public' AND r.relname='companies'",
        [name]
      );
      if (!result.rowCount) throw new Error('Expected validated company foreign key missing: ' + name);
    }


    const finalizedColumns = await client.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='company_id' AND table_name = ANY($1::text[]) AND is_nullable='YES'",
      [['customers','funeral_cases','staff','vehicles','inventory_items','stock_movements','tasks','invoices','payments']]
    );
    if (finalizedColumns.rowCount) throw new Error('Tenant finalization left nullable company_id columns: ' + finalizedColumns.rows.map(row => row.table_name).join(', '));

    const companyUniqueIndexes = [
      'uq_funeral_cases_company_case_code',
      'uq_vehicles_company_plate',
      'uq_inventory_items_company_sku',
      'uq_invoices_company_invoice_number'
    ];
    for (const name of companyUniqueIndexes) {
      const result = await client.query(
        "SELECT 1 FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid JOIN pg_namespace n ON n.oid=idx.relnamespace WHERE n.nspname='public' AND idx.relname=$1 AND i.indisunique AND i.indisvalid",
        [name]
      );
      if (!result.rowCount) throw new Error('Company-scoped unique index missing or invalid: ' + name);
    }

    const oldGlobalConstraints = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])",
      [['funeral_cases_case_code_key','vehicles_plate_key','inventory_items_sku_key','invoices_invoice_number_key']]
    );
    if (oldGlobalConstraints.rowCount) throw new Error('Legacy global unique constraints were not removed after replacement.');

    process.stdout.write('All draft tenant migrations and composite foreign keys verified on disposable PostgreSQL.\\n');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
