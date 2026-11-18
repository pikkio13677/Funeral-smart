'use strict';

const express = require('express');
const createTenantApi = require('./tenant-api-router');
const createPlatformAccess = require('./platform-access');
const createPlatformCompanyRouter = require('./platform-company-routes');
const createPlatformMarketplaceRouter = require('./platform-marketplace-routes');
const assertTenantCutoverReady = require('./tenant-cutover-guard');
const createProviderInvitationRouter = require('./provider-portal-invitation-routes');

function mountApiRouters({ app, pool, auth, emailNotifications, env = process.env, rateLimit }) {
  if (!app || typeof app.use !== 'function') throw new TypeError('An Express application is required.');
  if (!auth || !auth.router || typeof auth.authenticate !== 'function') throw new TypeError('The authentication module is required.');
  if (typeof rateLimit !== 'function') throw new TypeError('The rate-limit middleware factory is required.');

  // Defense in depth: never mount tenant routes unless both cutover switches agree.
  assertTenantCutoverReady(env);
  const multiTenantEnabled = env.ENABLE_MULTI_TENANT === 'true';
  const providerInvitationsEnabled = env.ENABLE_PROVIDER_PORTAL_INVITATIONS === 'true';
  const authRouter = express.Router();

  // Global user administration is unsafe in tenant mode: company admins must
  // use the membership-scoped routes under /api/v1/admin instead.
  if (multiTenantEnabled) {
    authRouter.use((req, res, next) => {
      let normalizedPath;
      try { normalizedPath = decodeURIComponent(req.path); }
      catch (_error) { return res.status(400).json({ error: 'Percorso non valido.' }); }
      if (/^\/users(?:\/|$)/i.test(normalizedPath)) {
        return res.status(404).json({ error: 'La gestione globale degli utenti non è disponibile in modalità multi-azienda.' });
      }
      return next();
    });
  }
  authRouter.use(auth.router);
  app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }), authRouter);

  // Provider invitation APIs are independently opt-in and remain disabled by default.
  // Startup performs a read-only schema preflight before the listener can open.
  let providerInvitationRouter = null;
  if (providerInvitationsEnabled) {
    providerInvitationRouter = createProviderInvitationRouter({
      pool,
      authenticate: auth.authenticate,
      sendInvitationEmail: emailNotifications?.notifyProviderUserInvitation,
      publicAppUrl: env.PUBLIC_APP_URL
    });
    app.use('/api/v1/provider-portal',
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
      providerInvitationRouter
    );
  }

  if (!multiTenantEnabled) {
    return { multiTenantEnabled: false, authRouter, providerInvitationsEnabled, providerInvitationRouter };
  }

  const tenantApi = createTenantApi({
    pool,
    authenticate: auth.authenticate,
    sendInvitationEmail: emailNotifications?.notifyCompanyInvitation,
    publicAppUrl: env.PUBLIC_APP_URL,
    cookieName: 'fs_session'
  });

  // Public registration is token-bound and receives a tighter rate limit.
  app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), tenantApi.invitationRegistrationRouter);
  app.use('/api/v1/auth', tenantApi.companyContextRouter);

  // This replaces, rather than supplements, the legacy global admin router.
  app.use('/api/v1/admin', tenantApi.router);

  const platformAccess = createPlatformAccess(pool);
  const platformRouter = createPlatformCompanyRouter(pool, {
    authenticate: auth.authenticate,
    requirePlatformRole: platformAccess.requirePlatformRole
  });
  app.use('/api/v1/platform', platformRouter);
  const marketplaceRouter = createPlatformMarketplaceRouter(pool, {
    authenticate: auth.authenticate,
    requirePlatformRole: platformAccess.requirePlatformRole
  });
  app.use('/api/v1/platform', marketplaceRouter);

  return { multiTenantEnabled: true, authRouter, tenantApi, platformRouter, marketplaceRouter, providerInvitationsEnabled, providerInvitationRouter };
}

module.exports = mountApiRouters;
