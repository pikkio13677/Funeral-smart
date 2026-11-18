'use strict';

const express = require('express');
const createTenantApi = require('./tenant-api-router');
const createPlatformAccess = require('./platform-access');
const createPlatformCompanyRouter = require('./platform-company-routes');
const createPlatformMarketplaceRouter = require('./platform-marketplace-routes');
const assertTenantCutoverReady = require('./tenant-cutover-guard');

function mountApiRouters({ app, pool, auth, emailNotifications, env = process.env, rateLimit }) {
  if (!app || typeof app.use !== 'function') throw new TypeError('An Express application is required.');
  if (!auth || !auth.router || typeof auth.authenticate !== 'function') throw new TypeError('The authentication module is required.');
  if (typeof rateLimit !== 'function') throw new TypeError('The rate-limit middleware factory is required.');

  // Defense in depth: never mount tenant routes unless both cutover switches agree.
  assertTenantCutoverReady(env);
  const multiTenantEnabled = env.ENABLE_MULTI_TENANT === 'true';
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

  // Provider marketplace access is separately gated; it is never enabled by tenant cutover.
  let providerPortal = null;
  if (env.ENABLE_PROVIDER_PORTAL === 'true') {
    const passThrough = (_req, _res, next) => next();
    const providerApi = express.Router();
    providerApi.use(auth.authenticate);
    providerApi.use(async (_req, res, next) => {
      try {
        const schema = await pool.query(
          `SELECT
             to_regclass('public.providers') IS NOT NULL AS providers,
             to_regclass('public.provider_user_access') IS NOT NULL AS provider_user_access,
             to_regclass('public.provider_user_invitations') IS NOT NULL AS provider_user_invitations,
             to_regclass('public.provider_inquiry_responses') IS NOT NULL AS provider_inquiry_responses,
             to_regclass('public.provider_portal_audit_log') IS NOT NULL AS provider_portal_audit_log,
             to_regclass('public.inquiry_provider_assignments') IS NOT NULL AS inquiry_provider_assignments,
             to_regclass('public.inquiries') IS NOT NULL AS inquiries`
        );
        if (!schema.rowCount || Object.values(schema.rows[0]).some(value => value !== true)) {
          return res.status(503).json({ error: 'Portale imprese non pronto: schema richiesto non disponibile.' });
        }
        return next();
      } catch (_error) {
        return res.status(503).json({ error: 'Verifica disponibilità portale imprese non riuscita.' });
      }
    });
    providerApi.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      let expectedOrigin;
      try {
        const configured = new URL(env.PUBLIC_APP_URL || '');
        if (configured.protocol !== 'https:') throw new Error('HTTPS required');
        expectedOrigin = configured.origin;
      } catch (_error) {
        return res.status(503).json({ error: 'Origine HTTPS del portale non configurata.' });
      }
      if (req.get('origin') !== expectedOrigin) {
        return res.status(403).json({ error: 'Origine della richiesta non autorizzata.' });
      }
      return next();
    });

    const createProviderPortalRouter = require('./provider-portal-routes');
    const createProviderPortalInvitationRouter = require('./provider-portal-invitation-routes');
    providerApi.use(createProviderPortalRouter(pool, { authenticate: passThrough }));
    providerApi.use(createProviderPortalInvitationRouter({
      pool,
      authenticate: passThrough,
      sendInvitationEmail: emailNotifications?.notifyProviderUserInvitation,
      publicAppUrl: env.PUBLIC_APP_URL
    }));
    app.use('/api/v1/provider-portal', rateLimit({
      windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false
    }), providerApi);
    providerPortal = { enabled: true };
  }

  if (!multiTenantEnabled) {
    return { multiTenantEnabled: false, authRouter };
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

  return { multiTenantEnabled: true, authRouter, tenantApi, platformRouter, marketplaceRouter, providerPortal };
}

module.exports = mountApiRouters;
