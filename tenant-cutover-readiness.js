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
  'fk_funeral_cases_tenant_customer',
  'fk_stock_movements_tenant_item',
  'fk_stock_movements_tenant_case',
  'fk_tasks_tenant_case',
  'fk_tasks_tenant_staff',
  'fk_invoices_tenant_case',
  'fk_invoices_tenant_customer',
  'fk_payments_tenant_invoice'
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
    'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(\'public.\' || name) IS NOT NULL',
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

  const missingConstraints = await pool.query(
    'SELECT name FROM unnest($1::text[]) AS name WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = name AND contype = \'f\')',
    [REQUIRED_FOREIGN_KEYS]
  );
  if (missingConstraints.rowCount) throw new Error('Tenant cutover blocked: composite foreign keys are incomplete: ' + missingConstraints.rows.map(row => row.name).join(', '));

  for (const table of TENANT_TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table + ' WHERE company_id IS NULL');
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: ' + table + ' still contains rows without company_id.');
  }

  for (const [label, sql] of RELATION_CHECKS) {
    const result = await pool.query(sql);
    if (Number(result.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: cross-company relation found in ' + label + '.');
  }

  const roleConstraint = await pool.query(
    "SELECT 1 FROM pg_constraint WHERE conname = 'app_users_role_check' AND pg_get_constraintdef(oid) LIKE '%platform_owner%'"
  );
  if (!roleConstraint.rowCount) throw new Error('Tenant cutover blocked: platform_owner role constraint is missing.');

  const bootstrap = await pool.query('SELECT singleton FROM platform_bootstrap_state WHERE singleton = TRUE');
  if (bootstrap.rowCount !== 1) throw new Error('Tenant cutover blocked: platform bootstrap singleton is missing.');

  const unassignedUsers = await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_users u WHERE u.active = TRUE AND u.role <> 'platform_owner' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id=u.id AND m.status='active')"
  );
  if (Number(unassignedUsers.rows[0].count) !== 0) throw new Error('Tenant cutover blocked: active non-platform users without an active company membership remain.');

  return { ready: true, checkedTables: TENANT_TABLES.length, checkedForeignKeys: REQUIRED_FOREIGN_KEYS.length };
}

module.exports = assertTenantSchemaReady;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.REQUIRED_TABLES = REQUIRED_TABLES;
module.exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
module.exports.REQUIRED_FOREIGN_KEYS = REQUIRED_FOREIGN_KEYS;
