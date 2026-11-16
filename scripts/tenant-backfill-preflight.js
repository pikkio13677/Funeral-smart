'use strict';

// Read-only tenant backfill preflight. Intended for disposable PostgreSQL or a
// locally restored production backup; never accepts remote database hosts.
const { Client } = require('pg');

const tenantTables = [
  'customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items',
  'stock_movements', 'tasks', 'invoices', 'payments'
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

    const constraintResult = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND conname IN (
        'fk_funeral_cases_tenant_customer',
        'fk_stock_movements_tenant_item',
        'fk_stock_movements_tenant_case',
        'fk_tasks_tenant_case',
        'fk_tasks_tenant_staff',
        'fk_invoices_tenant_case',
        'fk_invoices_tenant_customer',
        'fk_payments_tenant_invoice'
      )
      ORDER BY conname
    `);

    const report = {
      mode: 'read-only',
      databaseHost: url.hostname,
      unassignedCompanyRows: unassigned,
      crossTenantReferences,
      compositeForeignKeysFound: constraintResult.rows.map(row => row.conname),
      compositeForeignKeysExpected: 8,
      backfillReady: Object.values(crossTenantReferences).every(count => count === 0)
        && constraintResult.rowCount === 8
        && Object.values(unassigned).every(count => count === 0)
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\\n');
    if (Object.values(crossTenantReferences).some(count => count > 0)) {
      throw new Error('Cross-tenant references found. Do not run a backfill or enable tenant routes.');
    }
    if (constraintResult.rowCount !== 8) {
      throw new Error('Composite tenant foreign keys are incomplete.');
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
  process.stderr.write((error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
