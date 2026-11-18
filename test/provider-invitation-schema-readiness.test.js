'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertReady = require('../provider-invitation-schema-readiness');

test('provider invitation schema preflight confirms every required table with one read-only query', async () => {
  let call;
  const result = await assertReady({ async query(sql, values) {
    call = { sql, values };
    return { rows: [{ table0:true, table1:true, table2:true, table3:true, table4:true, table5:true, table6:true }] };
  } });
  assert.equal(result.ready, true);
  assert.equal(result.checkedTables, 7);
  assert.match(call.sql, /to_regclass/);
  assert.equal(call.values.length, 7);
});

test('provider invitation schema preflight fails closed and names missing tables', async () => {
  await assert.rejects(
    () => assertReady({ async query() { return { rows: [{ table0:true, table1:true, table2:false, table3:false, table4:true, table5:false, table6:true }] }; } }),
    /public\.inquiry_provider_assignments.*public\.provider_user_access.*public\.provider_portal_audit_log/
  );
});

test('provider invitation schema preflight rejects invalid pool', async () => {
  await assert.rejects(() => assertReady(null), /PostgreSQL-compatible pool/);
});
