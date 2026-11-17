'use strict';

const crypto = require('node:crypto');
const express = require('express');

const createTenantContext = require('./tenant-context');
const createCompanyContextRouter = require('./company-context-routes');
const createTenantDashboardRouter = require('./tenant-dashboard-routes');
const createTenantCustomersCasesRouter = require('./tenant-customers-cases-routes');
const createTenantStaffVehiclesRouter = require('./tenant-staff-vehicles-routes');
const createTenantInventoryTasksRouter = require('./tenant-inventory-tasks-routes');
const createTenantInvoicesPaymentsRouter = require('./tenant-invoices-payments-routes');
const createTenantCompanyAdminRouter = require('./tenant-company-admin-routes');
const createTenantAuditRouter = require('./tenant-audit-routes');
const createTenantInvitationRouter = require('./tenant-invitation-routes');
const createTenantInvitationRegistrationRouter = require('./tenant-invitation-registration-routes');

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Builds the dormant multi-company API.
 *
 * Mount companyContextRouter after the existing /api/v1/auth router, and mount
 * router at /api/v1/admin BEFORE the legacy admin router only after migrations
 * 005-008 and a verified backfill have been applied to the target database.
 * Do not mount this router while company_id is still nullable/unbackfilled.
 */
module.exports = function createTenantApi({
  pool,
  authenticate,
  sendInvitationEmail,
  publicAppUrl,
  cookieName = 'fs_session'
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
  }
  if (typeof authenticate !== 'function') {
    throw new TypeError('An authentication middleware is required.');
  }
  if (typeof cookieName !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(cookieName)) {
    throw new TypeError('A valid session cookie name is required.');
  }

  const router = express.Router();
  const tokenHash = hashSessionToken;
  const tenantContext = createTenantContext(pool, tokenHash, cookieName);
  const invitationRegistrationRouter = createTenantInvitationRegistrationRouter({ pool });
  const invitations = createTenantInvitationRouter({
    pool,
    sendInvitationEmail,
    publicAppUrl
  });

  // Invitation acceptance is intentionally before tenant context: a newly
  // invited user cannot have an active membership until acceptance succeeds.
  router.use(authenticate);
  router.use(invitations.acceptanceRouter);

  // All company data routes run only after identity, session, active membership
  // and active company have been revalidated from PostgreSQL.
  router.use(tenantContext);
  router.use(createTenantDashboardRouter(pool));
  router.use(createTenantCustomersCasesRouter(pool));
  router.use(createTenantStaffVehiclesRouter(pool));
  router.use(createTenantInventoryTasksRouter(pool));
  router.use(createTenantInvoicesPaymentsRouter(pool));
  router.use(createTenantCompanyAdminRouter(pool));
  router.use(createTenantAuditRouter(pool));
  router.use(invitations);

  // Company selection is authenticated but must be available before a tenant
  // is selected, so it is exposed separately under /api/v1/auth.
  const companyContextRouter = createCompanyContextRouter(
    pool,
    authenticate,
    tokenHash,
    cookieName
  );

  return { router, companyContextRouter, invitationRegistrationRouter };
};

module.exports.hashSessionToken = hashSessionToken;
