'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertTenantSchemaReady = require('../tenant-cutover-readiness');

function readyPool({ unassignedTable = null, missingConstraint = false, nullableCompanyId = false, missingUniqueIndex = false, remainingGlobalUnique = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      queries.push(sql);
      if (sql.includes('FROM unnest($1::text[]) AS items(name) WHERE to_regclass')) {
        return { rows: values[0].map(name => ({ name })), rowCount: values[0].length };
      }
      if (sql.includes('FROM information_schema.columns') && sql.includes("is_nullable = 'YES'")) {
        const rows = nullableCompanyId ? [{ name: 'customers' }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM information_schema.columns')) {
        const columns = [];
        for (let i = 0; i < values.length; i += 2) columns.push({ tableName: values[i], columnName: values[i + 1] });
        return { rows: columns, rowCount: columns.length };
      }
      if (sql.includes('FROM (VALUES') && sql.includes('pg_index')) {
        const rows = missingUniqueIndex ? [{ name: values[0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM (VALUES') && sql.includes('required.referenced_table')) {
        const rows = missingConstraint ? [{ name: values[0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM (VALUES') && sql.includes('JOIN pg_constraint c')) {
        const rows = remainingGlobalUnique ? [{ name: values[0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM (VALUES')) {
        const rows = missingConstraint ? [{ name: values[0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM [a-z_]+ WHERE company_id IS NULL/.test(sql)) {
        const table = sql.match(/FROM ([a-z_]+)/)[1];
        return { rows: [{ count: table === unassignedTable ? 2 : 0 }], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS count FROM')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.includes('FROM pg_constraint c') && sql.includes("t.relname='app_users'")) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('FROM platform_bootstrap_state')) return { rows: [{ singleton: true }], rowCount: 1 };
      if (sql.includes('FROM app_users u')) return { rows: [{ count: 0 }], rowCount: 1 };
      throw new Error('Unexpected readiness query: ' + sql);
    }
  };
}

test('tenant startup preflight accepts a complete, backfilled schema', async () => {
  const pool = readyPool();
  const result = await assertTenantSchemaReady(pool);
  assert.deepEqual(result, { ready: true, checkedTables: 9, checkedForeignKeys: 21, checkedUniqueIndexes: 4 });
  assert.ok(pool.queries.every(sql => !/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|BEGIN)\b/i.test(sql)));
  const roleCheck = pool.queries.find(sql => sql.includes("t.relname='app_users'"));
  assert.match(roleCheck, /c\.convalidated/);
  assert.match(roleCheck, /c\.contype='c'/);
  const foreignKeyCheck = pool.queries.find(sql => sql.includes('pg_constraint c') && sql.includes('required.referenced_table'));
  assert.ok(foreignKeyCheck.includes('c.conkey'));
  assert.ok(foreignKeyCheck.includes('c.confkey'));
  assert.ok(foreignKeyCheck.includes('source_table.relname=required.table_name'));
  assert.ok(foreignKeyCheck.includes('target_table.relname=required.referenced_table'));
  const uniqueCheck = pool.queries.find(sql => sql.includes('FROM (VALUES') && sql.includes('pg_index'));
  assert.match(uniqueCheck, /i\.indisunique/);
  assert.match(uniqueCheck, /i\.indisvalid/);
});

test('tenant startup preflight blocks rows without company ownership', async () => {
  await assert.rejects(
    () => assertTenantSchemaReady(readyPool({ unassignedTable: 'customers' })),
    /customers still contains rows without company_id/
  );
});

test('tenant startup preflight blocks missing composite foreign keys', async () => {
  await assert.rejects(
    () => assertTenantSchemaReady(readyPool({ missingConstraint: true })),
    /composite foreign keys are incomplete/
  );
});

test('tenant startup preflight blocks a same-named foreign key with wrong columns or target', async () => {
  const pool = readyPool({ missingConstraint: true });
  await assert.rejects(
    () => assertTenantSchemaReady(pool),
    /composite foreign keys are incomplete or unvalidated/
  );
  const foreignKeyCheck = pool.queries.find(sql => sql.includes('required.referenced_table'));
  assert.ok(foreignKeyCheck.includes('string_to_array(required.local_columns'));
  assert.ok(foreignKeyCheck.includes('string_to_array(required.referenced_columns'));
});

test('tenant startup preflight blocks nullable company_id columns', async () => {
  await assert.rejects(
    () => assertTenantSchemaReady(readyPool({ nullableCompanyId: true })),
    /company_id must be NOT NULL on: customers/
  );
});

test('tenant startup preflight blocks missing company-scoped unique indexes', async () => {
  await assert.rejects(
    () => assertTenantSchemaReady(readyPool({ missingUniqueIndex: true })),
    /company-scoped unique indexes are missing or invalid/
  );
});

test('tenant startup preflight blocks legacy global unique constraints', async () => {
  await assert.rejects(
    () => assertTenantSchemaReady(readyPool({ remainingGlobalUnique: true })),
    /legacy global unique constraints remain/
  );
});
