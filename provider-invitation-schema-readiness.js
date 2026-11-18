'use strict';

const REQUIRED_PROVIDER_INVITATION_TABLES = [
  'public.providers',
  'public.app_users',
  'public.inquiry_provider_assignments',
  'public.provider_user_access',
  'public.provider_user_invitations',
  'public.provider_portal_audit_log'
];

async function assertProviderInvitationSchemaReady(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }
  const result = await pool.query(
    'SELECT ' + REQUIRED_PROVIDER_INVITATION_TABLES.map((_, index) =>
      `to_regclass($${index + 1}) IS NOT NULL AS "table${index}"`
    ).join(', '),
    REQUIRED_PROVIDER_INVITATION_TABLES
  );
  const row = result.rows?.[0] || {};
  const missing = REQUIRED_PROVIDER_INVITATION_TABLES.filter((_, index) => row[`table${index}`] !== true);
  if (missing.length) {
    throw new Error('Provider invitation API non attivabile: schema incompleto. Tabelle mancanti: ' + missing.join(', '));
  }
  return { ready: true, checkedTables: REQUIRED_PROVIDER_INVITATION_TABLES.length };
}

module.exports = assertProviderInvitationSchemaReady;
