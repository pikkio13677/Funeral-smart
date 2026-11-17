'use strict';

const TENANT_TABLES = Object.freeze([
  'customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items',
  'stock_movements', 'tasks', 'invoices', 'payments'
]);

const REQUIRED_TABLES = Object.freeze([
  'companies', 'company_memberships', 'company_invitations',
  'platform_access', 'platform_bootstrap_state', 'platform_audit_log'
]);

const REQUIRED_COLUMNS = Object.freeze([
  ['app_sessions', 'user_id'], ['app_sessions', 'token_hash'], ['app_sessions', 'expires_at'], ['app_sessions', 'active_membership_id'],
  ['app_users', 'id'], ['app_users', 'username'], ['app_users', 'display_name'], ['app_users', 'role'], ['app_users', 'active'], ['app_users', 'email'], ['app_users', 'email_verified_at'],
  ['audit_log', 'user_id'], ['audit_log', 'username'], ['audit_log', 'action'], ['audit_log', 'resource'], ['audit_log', 'resource_id'], ['audit_log', 'ip_address'], ['audit_log', 'created_at'], ['audit_log', 'company_id'], ['audit_log', 'membership_id'],
  ['companies', 'id'], ['companies', 'legal_name'], ['companies', 'vat_number'], ['companies', 'address'], ['companies', 'city'], ['companies', 'province'], ['companies', 'email'], ['companies', 'phone'], ['companies', 'status'], ['companies', 'plan_code'], ['companies', 'created_at'], ['companies', 'updated_at'],
  ['company_memberships', 'id'], ['company_memberships', 'company_id'], ['company_memberships', 'user_id'], ['company_memberships', 'role'], ['company_memberships', 'status'], ['company_memberships', 'created_at'], ['company_memberships', 'updated_at'],
  ['company_invitations', 'id'], ['company_invitations', 'company_id'], ['company_invitations', 'email'], ['company_invitations', 'role'], ['company_invitations', 'token_hash'], ['company_invitations', 'invited_by_membership_id'], ['company_invitations', 'status'], ['company_invitations', 'expires_at'], ['company_invitations', 'accepted_at'], ['company_invitations', 'revoked_at'], ['company_invitations', 'created_at'],
  ['platform_access', 'user_id'], ['platform_access', 'role'], ['platform_access', 'status'], ['platform_access', 'granted_at'], ['platform_access', 'updated_at'],
  ['platform_bootstrap_state', 'singleton'], ['platform_bootstrap_state', 'consumed_at'], ['platform_bootstrap_state', 'consumed_by'],
  ['platform_audit_log', 'id'], ['platform_audit_log', 'actor_user_id'], ['platform_audit_log', 'actor_username'], ['platform_audit_log', 'action'], ['platform_audit_log', 'resource'], ['platform_audit_log', 'resource_id'], ['platform_audit_log', 'reason'], ['platform_audit_log', 'ip_address'], ['platform_audit_log', 'created_at'],
  ...TENANT_TABLES.map(table => [table, 'company_id'])
]);

const REQUIRED_FOREIGN_KEYS = Object.freeze([
  { name: 'fk_app_sessions_active_membership_user', table: 'app_sessions' },
  { name: 'fk_audit_log_tenant_membership', table: 'audit_log' },
  { name: 'fk_funeral_cases_tenant_customer', table: 'funeral_cases' },
  { name: 'fk_stock_movements_tenant_item', table: 'stock_movements' },
  { name: 'fk_stock_movements_tenant_case', table: 'stock_movements' },
  { name: 'fk_tasks_tenant_case', table: 'tasks' },
  { name: 'fk_tasks_tenant_staff', table: 'tasks' },
  { name: 'fk_invoices_tenant_case', table: 'invoices' },
  { name: 'fk_invoices_tenant_customer', table: 'invoices' },
  { name: 'fk_payments_tenant_invoice', table: 'payments' },
  { name: 'fk_company_invitations_company', table: 'company_invitations' },
  { name: 'fk_company_invitations_inviter_membership', table: 'company_invitations' }
]);

const REQUIRED_UNIQUE_INDEXES = Object.freeze([
  { name: 'uq_funeral_cases_company_case_code', table: 'funeral_cases', keyColumns: '(company_id, case_code)' },
  { name: 'uq_vehicles_company_plate', table: 'vehicles', keyColumns: '(company_id, plate)' },
  { name: 'uq_inventory_items_company_sku', table: 'inventory_items', keyColumns: '(company_id, sku)' },
  { name: 'uq_invoices_company_invoice_number', table: 'invoices', keyColumns: '(company_id, invoice_number)' }
]);

const LEGACY_GLOBAL_UNIQUE_CONSTRAINTS = Object.freeze([
  { name: 'funeral_cases_case_code_key', table: 'funeral_cases' },
  { name: 'vehicles_plate_key', table: 'vehicles' },
  { name: 'inventory_items_sku_key', table: 'inventory_items' },
  { name: 'invoices_invoice_number_key', table: 'invoices' }
]);

const RELATION_CHECKS = Object.freeze([
  ['funeral_cases.customer_id', 'SELECT COUNT(*)::int AS count FROM funeral_cases c JOIN customers p ON p.id=c.customer_id WHERE c.company_id IS DISTINCT FROM p.company_id'],
  ['stock_movements.item_id', 'SELECT COUNT(*)::int AS count FROM stock_movements c JOIN inventory_items p ON p.id=c.item_id WHERE c.company_id IS DISTINCT FROM p.company_id'],
  ['stock_movements.case_id', 'SELECT COUNT(*)::int AS count FROM stock_movements c JOIN funeral_cases p ON p.id=c.case_id WHERE c.case_id IS NOT NULL AND c.company_id IS DISTINCT FROM p.company_id'],
  ['tasks.case_id', 'SELECT COUNT(*)::int AS count FROM tasks c JOIN funeral_cases p ON p.id=c.case_id WHERE c.case_id IS NOT NULL AND c.company_id IS DISTINCT FROM p.company_id'],
  ['tasks.assigned_to', 'SELECT COUNT(*)::int AS count FROM tasks c JOIN staff p ON p.id=c.assigned_to WHERE c.assigned_to IS NOT NULL AND c.company_id IS DISTINCT FROM p.company_id'],
  ['invoices.case_id', 'SELECT COUNT(*)::int AS count FROM invoices c JOIN funeral_cases p ON p.id=c.case_id WHERE c.case_id IS NOT NULL AND c.company_id IS DISTINCT FROM p.company_id'],
  ['invoices.customer_id', 'SELECT COUNT(*)::int AS count FROM invoices c JOIN customers p ON p.id=c.customer_id WHERE c.customer_id IS NOT NULL AND c.company_id IS DISTINCT FROM p.company_id'],
  ['payments.invoice_id', 'SELECT COUNT(*)::int AS count FROM payments c JOIN invoices p ON p.id=c.invoice_id WHERE c.company_id IS DISTINCT FROM p.company_id']
]);

async function assertTenantSchemaReady(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');

  const tableResult = await pool.query(
    'SELECT name FROM unnest($1::text[]) AS items(name) WHERE to_regclass(\'public.\' || items.name) IS NOT NULL',
    [REQUIRED_TABLES]
  );
  const foundTables = new Set(tableResult.rows.map(row => row.name));
  const missingTables = REQUIRED_TABLES.filter(name => !foundTables.has(name));
  if (missingTables.length) throw new Error('Tenant cutover blocked: missing tables: ' + missingTables.join(', '));

  const columnResult = await pool.query(
    'SELECT table_name AS "tableName", column_name AS "columnName" FROM information_schema.columns WHERE table_schema = \'public\' AND (table_name, column_name) IN (' +
    REQUIRED_COLUMNS.map((_, index) => '(' + '$' + (index * 2 + 1) + ', $' + (index * 2 + 2) + ')').join(', ') + ')',
    REQUIRED_COLUMNS.flat()
  );
  const foundColumns = new Set(columnResult.rows.map(row => row.tableName + '.' + row.columnName));
  const missingColumns = REQUIRED_COLUMNS.map(([table, column]) => table + '.' + column).filter(name => !foundColumns.has(name));
  if (missingColumns.length) throw new Error('Tenant cutover blocked: missing columns: ' + missingColumns.join(', '));

  const nullableCompanyIds = await pool.query(
    "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'company_id' AND table_name = ANY($1::text[]) AND is_nullable = 'YES'",
    [TENANT_TABLES]
  );
  if (nullableCompanyIds.rowCount) throw new Error('Tenant cutover blocked: company_id must be NOT NULL on: ' + nullableCompanyIds.rows.map(row => row.name).join(', '));

  const foreignKeyValues = REQUIRED_FOREIGN_KEYS.flatMap(item => [item.name, item.table]);
  const foreignKeyPairs = REQUIRED_FOREIGN_KEYS.map((_, index) => '(' + '$' + (index * 2 + 1) + '::text, $' + (index * 2 + 2) + '::text)').join(', ');
  const missingConstraints = await pool.query(
    'SELECT required.name FROM (VALUES ' + foreignKeyPairs + ') AS required(name, table_name) ' +
    'WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid ' +
    'JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=\'public\' ' +
    'AND t.relname=required.table_name AND c.conname=required.name AND c.contype=\'f\' AND c.convalidated)',
    foreignKeyValues
  );
  if (missingConstraints.rowCount) throw new Error('Tenant cutover blocked: composite foreign keys are incomplete or unvalidated: ' + missingConstraints.rows.map(row => row.name).join(', '));

  const uniqueIndexValues = REQUIRED_UNIQUE_INDEXES.flatMap(item => [item.name, item.table, item.keyColumns]);
  const uniqueIndexTuples = REQUIRED_UNIQUE_INDEXES.map((_, index) =>
    '($' + (index * 3 + 1) + '::text, $' + (index * 3 + 2) + '::text, $' + (index * 3 + 3) + '::text)'
  ).join(', ');
  const missingUniqueIndexes = await pool.query(
    'SELECT required.name FROM (VALUES ' + uniqueIndexTuples + ') AS required(name, table_name, key_columns) ' +
    'WHERE NOT EXISTS (SELECT 1 FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid ' +
    'JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace ' +
    'WHERE n.nspname=\'public\' AND t.relname=required.table_name AND idx.relname=required.name ' +
    'AND i.indisunique AND i.indisvalid AND pg_get_indexdef(i.indexrelid) LIKE \'%\' || required.key_columns || \'%\')',
    uniqueIndexValues
  );
  if (missingUniqueIndexes.rowCount) throw new Error('Tenant cutover blocked: company-scoped unique indexes are missing or invalid: ' + missingUniqueIndexes.rows.map(row => row.name).join(', '));

  const legacyUniqueValues = LEGACY_GLOBAL_UNIQUE_CONSTRAINTS.flatMap(item => [item.name, item.table]);
  const legacyUniqueTuples = LEGACY_GLOBAL_UNIQUE_CONSTRAINTS.map((_, index) =>
    '($' + (index * 2 + 1) + '::text, $' + (index * 2 + 2) + '::text)'
  ).join(', ');
  const remainingGlobalUnique = await pool.query(
    'SELECT c.conname AS name FROM (VALUES ' + legacyUniqueTuples + ') AS required(name, table_name) ' +
    'JOIN pg_constraint c ON c.conname=required.name JOIN pg_class t ON t.oid=c.conrelid ' +
    'JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=\'public\' AND t.relname=required.table_name',
    legacyUniqueValues
  );
  if (remainingGlobalUnique.rowCount) throw new Error('Tenant cutover blocked: legacy global unique constraints remain: ' + remainingGlobalUnique.rows.map(row => row.name).join(', '));

  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length, checkedUniqueIndexes: REQUIRED_UNIQUE_INDEXES.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
module.exports.REQUIRED_UNIQUE_INDEXES = REQUIRED_UNIQUE_INDEXES;
module.exports.LEGACY_GLOBAL_UNIQUE_CONSTRAINTS = LEGACY_GLOBAL_UNIQUE_CONSTRAINTS;
 + (index * 3 + 1) + '::text, 
  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
 + (index * 3 + 2) + '::text, 
  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
 + (index * 3 + 3) + '::text)'
  ).join(', ');
  const missingUniqueIndexes = await pool.query(
    'SELECT required.name FROM (VALUES ' + uniqueIndexTuples + ') AS required(name, table_name, key_columns) ' +
    'WHERE NOT EXISTS (SELECT 1 FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid ' +
    'JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace ' +
    'WHERE n.nspname=\'public\' AND t.relname=required.table_name AND idx.relname=required.name ' +
    'AND i.indisunique AND i.indisvalid AND pg_get_indexdef(i.indexrelid) LIKE \'%\' || required.key_columns || \'%\')',
    uniqueIndexValues
  );
  if (missingUniqueIndexes.rowCount) throw new Error('Tenant cutover blocked: company-scoped unique indexes are missing or invalid: ' + missingUniqueIndexes.rows.map(row => row.name).join(', '));

  const legacyUniqueValues = LEGACY_GLOBAL_UNIQUE_CONSTRAINTS.flatMap(item => [item.name, item.table]);
  const legacyUniqueTuples = LEGACY_GLOBAL_UNIQUE_CONSTRAINTS.map((_, index) =>
    '(
  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
 + (index * 2 + 1) + '::text, 
  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
 + (index * 2 + 2) + '::text)'
  ).join(', ');
  const remainingGlobalUnique = await pool.query(
    'SELECT c.conname AS name FROM (VALUES ' + legacyUniqueTuples + ') AS required(name, table_name) ' +
    'JOIN pg_constraint c ON c.conname=required.name JOIN pg_class t ON t.oid=c.conrelid ' +
    'JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=\'public\' AND t.relname=required.table_name',
    legacyUniqueValues
  );
  if (remainingGlobalUnique.rowCount) throw new Error('Tenant cutover blocked: legacy global unique constraints remain: ' + remainingGlobalUnique.rows.map(row => row.name).join(', '));

  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid " +
    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' " +
    "AND t.relname='app_users' AND c.conname='app_users_role_check' " +
    "AND c.contype='c' AND c.convalidated " +
    "AND pg_get_constraintdef(c.oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active') AND NOT EXISTS (SELECT 1 FROM platform_access pa WHERE pa.user_id=u.id AND pa.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
