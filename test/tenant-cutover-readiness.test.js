'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertTenantSchemaReady = require('../tenant-cutover-readiness');

function readyPool({ unassignedTable = null, missingConstraint = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      queries.push(sql);
      if (sql.includes('FROM unnest($1::text[]) AS name WHERE to_regclass')) {
        return { rows: values[0].map(name => ({ name })), rowCount: values[0].length };
      }
      if (sql.includes('FROM information_schema.columns')) {
        const columns = [];
        for (let i = 0; i < values.length; i += 2) columns.push({ tableName: values[i], columnName: values[i + 1] });
        return { rows: columns, rowCount: columns.length };
      }
      if (sql.includes('FROM unnest($1::text[]) AS name WHERE NOT EXISTS')) {
        const rows = missingConstraint ? [{ name: values[0][0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM [a-z_]+ WHERE company_id IS NULL/.test(sql)) {
        const table = sql.match(/FROM ([a-z_]+)/)[1];
        return { rows: [{ count: table === unassignedTable ? 2 : 0 }], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS count FROM')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.includes('FROM pg_constraint')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('FROM platform_bootstrap_state')) return { rows: [{ singleton: true }], rowCount: 1 };
      if (sql.includes('FROM app_users u')) return { rows: [{ count: 0 }], rowCount: 1 };
      throw new Error('Unexpected readiness query: ' + sql);
    }
  };
}

test('tenant startup preflight accepts a complete, backfilled schema', async () => {
  const pool = readyPool();
  const result = await assertTenantSchemaReady(pool);
  assert.deepEqual(result, { ready: true, checkedTables: 9, checkedForeignKeys: 8 });
  assert.ok(pool.queries.every(sql => !/^\\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|BEGIN)\\b/i.test(sql)));
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
