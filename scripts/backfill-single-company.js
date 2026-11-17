'use strict';

// Single-company legacy backfill. Dry-run by default.
// --apply is permitted only against a disposable database on localhost.
// It never creates a company, invents legal details, changes legacy audit rows,
// sends email, or touches a remote/production database.

const { Client } = require('pg');

const TENANT_TABLES = Object.freeze([
  'customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items',
  'stock_movements', 'tasks', 'invoices', 'payments'
]);
const COMPANY_ROLES = new Set(['admin', 'manager', 'operator', 'warehouse', 'accounting']);

function assertLocalDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Refusing a remote database host. Restore a backup to localhost first.');
  }
  return url;
}

async function backfillSingleCompany(client, companyId, { apply = false } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.');
  if (typeof companyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    throw new Error('A valid existing COMPANY_ID is required.');
  }

  await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
  try {
    const company = await client.query(
      "SELECT id, status FROM companies WHERE id=$1",
      [companyId]
    );
    const companyCount = await client.query('SELECT COUNT(*)::int AS count FROM companies');
    if (company.rowCount !== 1 || Number(companyCount.rows[0].count) !== 1) {
      throw new Error('Expected exactly one existing company matching COMPANY_ID. No company was created.');
    }
    if (company.rows[0].status !== 'active') throw new Error('The initial company must be active.');

    const columns = await client.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='public' " +
      "AND column_name='company_id' AND table_name=ANY($1::text[])",
      [TENANT_TABLES]
    );
    const found = new Set(columns.rows.map(row => row.table_name));
    const missing = TENANT_TABLES.filter(table => !found.has(table));
    if (missing.length) throw new Error('Missing company_id columns: ' + missing.join(', '));

    const rowCounts = {};
    const pendingRows = {};
    for (const table of TENANT_TABLES) {
      const result = await client.query(
        'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE company_id IS NULL)::int AS unassigned, ' +
        'COUNT(*) FILTER (WHERE company_id IS NOT NULL AND company_id <> $1)::int AS conflicting ' +
        'FROM ' + table,
        [companyId]
      );
      rowCounts[table] = result.rows[0].total;
      pendingRows[table] = result.rows[0].unassigned;
      if (Number(result.rows[0].conflicting) > 0) {
        throw new Error('Rows already assigned to a different company exist in ' + table + '. Stop for manual review.');
      }
    }

    const users = await client.query(
      'SELECT id, role, active FROM app_users ORDER BY id'
    );
    const membershipsToCreate = [];
    const platformOwners = [];
    for (const user of users.rows) {
      if (user.role === 'platform_owner') {
        platformOwners.push(user.id);
        continue;
      }
      if (!COMPANY_ROLES.has(user.role)) {
        throw new Error('Unsupported legacy role found. Stop and map it explicitly before backfill.');
      }
      const existing = await client.query(
        'SELECT company_id, role, status FROM company_memberships WHERE user_id=$1',
        [user.id]
      );
      if (existing.rows.some(row => row.company_id !== companyId)) {
        throw new Error('A user already has a membership in another company. Stop for manual review.');
      }
      if (existing.rows.some(row => row.role !== user.role)) {
        throw new Error('An existing membership role differs from the legacy account role. Stop for manual review.');
      }
      if (!existing.rowCount) membershipsToCreate.push({
        userId: user.id,
        role: user.role,
        status: user.active ? 'active' : 'suspended'
      });
    }

    const sessionConflicts = await client.query(
      'SELECT COUNT(*)::int AS count FROM app_sessions s ' +
      'LEFT JOIN company_memberships m ON m.id=s.active_membership_id AND m.user_id=s.user_id ' +
      'WHERE s.active_membership_id IS NOT NULL AND m.id IS NULL'
    );
    if (Number(sessionConflicts.rows[0].count) > 0) {
      throw new Error('Existing sessions reference a membership belonging to another user or a missing membership.');
    }

    const report = {
      mode: apply ? 'apply-on-local-clone' : 'dry-run-read-only',
      companyCount: Number(companyCount.rows[0].count),
      legacyUsers: users.rowCount,
      membershipsToCreate: membershipsToCreate.length,
      platformOwnersNotAssignedToCompany: platformOwners.length,
      tableRows: rowCounts,
      rowsToAssign: pendingRows,
      activeSessionsToLink: null,
      auditHistory: 'unchanged'
    };

    if (!apply) {
      const sessions = await client.query(
        'SELECT COUNT(*)::int AS count FROM app_sessions WHERE active_membership_id IS NULL'
      );
      report.activeSessionsToLink = sessions.rows[0].count;
      await client.query('ROLLBACK');
      return report;
    }

    for (const table of TENANT_TABLES) {
      await client.query(
        'UPDATE ' + table + ' SET company_id=$1 WHERE company_id IS NULL',
        [companyId]
      );
    }

    for (const membership of membershipsToCreate) {
      await client.query(
        'INSERT INTO company_memberships(company_id,user_id,role,status) VALUES($1,$2,$3,$4)',
        [companyId, membership.userId, membership.role, membership.status]
      );
    }

    await client.query(
      'UPDATE app_sessions s SET active_membership_id=m.id ' +
      'FROM company_memberships m WHERE m.user_id=s.user_id AND m.company_id=$1 ' +
      'AND s.active_membership_id IS NULL',
      [companyId]
    );

    for (const table of TENANT_TABLES) {
      const check = await client.query(
        'SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS DISTINCT FROM $1',
        [companyId]
      );
      if (Number(check.rows[0].count) !== 0) {
        throw new Error('Post-backfill verification failed for ' + table + '.');
      }
    }

    const missingMemberships = await client.query(
      "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.role <> 'platform_owner' " +
      'AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.company_id=$1)',
      [companyId]
    );
    if (Number(missingMemberships.rows[0].count) !== 0) {
      throw new Error('One or more non-platform users remain without a company membership.');
    }

    const badSessions = await client.query(
      'SELECT COUNT(*)::int AS count FROM app_sessions s ' +
      'JOIN app_users u ON u.id=s.user_id ' +
      "WHERE u.role <> 'platform_owner' AND NOT EXISTS (" +
      'SELECT 1 FROM company_memberships m WHERE m.id=s.active_membership_id ' +
      'AND m.user_id=s.user_id AND m.company_id=$1)',
      [companyId]
    );
    if (Number(badSessions.rows[0].count) !== 0) {
      throw new Error('One or more legacy sessions could not be linked to the company membership.');
    }

    const linkedSessions = await client.query(
      'SELECT COUNT(*)::int AS count FROM app_sessions WHERE active_membership_id IS NOT NULL'
    );
    report.activeSessionsToLink = Number(linkedSessions.rows[0].count);
    report.membershipsCreated = membershipsToCreate.length;
    report.rowsAssigned = Object.values(pendingRows).reduce((sum, count) => sum + Number(count), 0);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  assertLocalDatabase(databaseUrl);
  const companyId = process.env.COMPANY_ID;
  const apply = process.argv.includes('--apply');
  if (process.argv.some(arg => !['--apply', '--dry-run'].includes(arg))) {
    throw new Error('Only --dry-run or --apply is supported.');
  }
  if (apply && process.env.CONFIRM_SINGLE_COMPANY_BACKFILL !== 'YES') {
    throw new Error('For local clone apply, set CONFIRM_SINGLE_COMPANY_BACKFILL=YES explicitly.');
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  await client.connect();
  try {
    const report = await backfillSingleCompany(client, companyId, { apply });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!apply) process.stdout.write('DRY RUN ONLY: no rows or memberships were changed.\n');
    else process.stdout.write('LOCAL CLONE BACKFILL COMMITTED. Production was not accessed.\n');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write((error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { TENANT_TABLES, assertLocalDatabase, backfillSingleCompany };
