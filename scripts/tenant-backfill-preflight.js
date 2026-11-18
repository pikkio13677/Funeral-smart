'use strict';

// Read-only tenant backfill preflight. Intended for disposable PostgreSQL or a
// locally restored production backup; never accepts remote database hosts.
const { Client } = require('pg');

const tenantTables = [
  'customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items',
  'stock_movements', 'tasks', 'invoices', 'payments'
];

const compositeForeignKeys = [
  ['funeral_cases', 'fk_funeral_cases_tenant_customer'],
  ['stock_movements', 'fk_stock_movements_tenant_item'],
  ['stock_movements', 'fk_stock_movements_tenant_case'],
  ['tasks', 'fk_tasks_tenant_case'],
  ['tasks', 'fk_tasks_tenant_staff'],
  ['invoices', 'fk_invoices_tenant_case'],
  ['invoices', 'fk_invoices_tenant_customer'],
  ['payments', 'fk_payments_tenant_invoice']
];

const relationChecks = [
  ['funeral_cases.customer_id -> customers', `
    SELECT COUNT(*)::int AS count
    FROM funeral_cases child JOIN customers parent ON parent.id = child.customer_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['stock_movements.item_id -> inventory_items', `
    SELECT COUNT(*)::int AS count
    FROM stock_movements child JOIN inventory_items parent ON parent.id = child.item_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['stock_movements.case_id -> funeral_cases', `
    SELECT COUNT(*)::int AS count
    FROM stock_movements child JOIN funeral_cases parent ON parent.id = child.case_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['tasks.case_id -> funeral_cases', `
    SELECT COUNT(*)::int AS count
    FROM tasks child JOIN funeral_cases parent ON parent.id = child.case_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['tasks.assigned_to -> staff', `
    SELECT COUNT(*)::int AS count
    FROM tasks child JOIN staff parent ON parent.id = child.assigned_to
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['invoices.case_id -> funeral_cases', `
    SELECT COUNT(*)::int AS count
    FROM invoices child JOIN funeral_cases parent ON parent.id = child.case_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['invoices.customer_id -> customers', `
    SELECT COUNT(*)::int AS count
    FROM invoices child JOIN customers parent ON parent.id = child.customer_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`],
  ['payments.invoice_id -> invoices', `
    SELECT COUNT(*)::int AS count
    FROM payments child JOIN invoices parent ON parent.id = child.invoice_id
    WHERE child.company_id IS NOT NULL AND parent.company_id IS NOT NULL
      AND child.company_id <> parent.company_id`]
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to inspect a production runtime.');
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Refusing non-local database host; restore a backup locally first.');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const unassigned = {};
    for (const table of tenantTables) {
      const result = await client.query(
        'SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL'
      );
      unassigned[table] = result.rows[0].count;
    }

    const crossTenantReferences = {};
    for (const [label, query] of relationChecks) {
      const result = await client.query(query);
      crossTenantReferences[label] = result.rows[0].count;
    }

    const constraintResult = await client.query(
      "SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
      "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
      "AND c.contype='f' AND c.convalidated AND (t.relname,c.conname) IN (" +
      compositeForeignKeys.map((_, i) => "($" + (i * 2 + 1) + ",$" + (i * 2 + 2) + ")").join(',') + ")",
      compositeForeignKeys.flat()
    );

    const companyForeignKeyNames = [
      'customers_company_id_fkey', 'funeral_cases_company_id_fkey', 'staff_company_id_fkey',
      'vehicles_company_id_fkey', 'inventory_items_company_id_fkey', 'stock_movements_company_id_fkey',
      'tasks_company_id_fkey', 'invoices_company_id_fkey', 'payments_company_id_fkey'
    ];
    const companyConstraintResult = await client.query(
      "SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid " +
      "JOIN pg_namespace n ON n.oid=r.relnamespace WHERE c.conname=ANY($1::text[]) " +
      "AND c.contype='f' AND c.convalidated AND n.nspname='public' AND r.relname='companies'",
      [companyForeignKeyNames]
    );

    const uniqueIndexNames = [
      'uq_funeral_cases_company_case_code', 'uq_vehicles_company_plate',
      'uq_inventory_items_company_sku', 'uq_invoices_company_invoice_number'
    ];
    const uniqueIndexResult = await client.query(
      'SELECT idx.relname FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid ' +
      'WHERE idx.relname=ANY($1::text[]) AND i.indisunique AND i.indisvalid',
      [uniqueIndexNames]
    );
    const nullableCompanyIds = await client.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='public' " +
      "AND column_name='company_id' AND table_name=ANY($1::text[]) AND is_nullable='YES'",
      [tenantTables]
    );
    const legacyGlobalUnique = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])",
      [['funeral_cases_case_code_key','vehicles_plate_key','inventory_items_sku_key','invoices_invoice_number_key']]
    );
    const unassignedUsers = await client.query(
      "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active=TRUE AND u.role<>'platform_owner' " +
      "AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') " +
      "AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
    );

    const report = {
      mode: 'read-only',
      databaseHost: url.hostname,
      unassignedCompanyRows: unassigned,
      crossTenantReferences,
      compositeForeignKeysFound: constraintResult.rows.map(row => row.conname),
      compositeForeignKeysExpected: 8,
      companyForeignKeysFound: companyConstraintResult.rows.map(row => row.conname),
      companyForeignKeysExpected: companyForeignKeyNames.length,
      companyUniqueIndexesFound: uniqueIndexResult.rows.map(row => row.relname),
      companyUniqueIndexesExpected: uniqueIndexNames.length,
      nullableCompanyIdTables: nullableCompanyIds.rows.map(row => row.table_name),
      remainingGlobalUniqueConstraints: legacyGlobalUnique.rows.map(row => row.conname),
      activeUsersWithoutMembership: unassignedUsers.rows[0].count,
      backfillReady: Object.values(crossTenantReferences).every(count => Number(count) === 0)
        && constraintResult.rowCount === 8
        && companyConstraintResult.rowCount === companyForeignKeyNames.length
        && uniqueIndexResult.rowCount === uniqueIndexNames.length
        && nullableCompanyIds.rowCount === 0
        && legacyGlobalUnique.rowCount === 0
        && Number(unassignedUsers.rows[0].count) === 0
        && Object.values(unassigned).every(count => Number(count) === 0)
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (Object.values(crossTenantReferences).some(count => count > 0)) {
      throw new Error('Cross-tenant references found. Do not run a backfill or enable tenant routes.');
    }
    if (constraintResult.rowCount !== 8) {
      throw new Error('Composite tenant foreign keys are incomplete.');
    }
    if (companyConstraintResult.rowCount !== companyForeignKeyNames.length) {
      throw new Error('Validated company ownership foreign keys are incomplete.');
    }
    if (Object.values(unassigned).some(count => count > 0)) {
      process.stdout.write('PRECHECK: company_id backfill is still required; no data was changed.\\n');
    } else {
      process.stdout.write('PRECHECK: all managed rows have company_id and no cross-tenant links were found.\\n');
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
