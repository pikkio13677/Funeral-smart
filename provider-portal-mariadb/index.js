'use strict';

const express = require('express');
const createMariaDbProviderPortalRouter = require('./routes');
const createMariaDbProviderInvitationRouter = require('./invitation-routes');

/**
 * Mount both MariaDB Area Imprese routers under the same API prefix.
 *
 * Invitation routes must be mounted first: the platform-level
 * POST /providers/:providerId/invitations and authenticated
 * POST /invitations/accept do not require an existing provider membership.
 * The portal router applies provider membership context to its own endpoints.
 */
function createMariaDbProviderAreaRouter(database, options = {}) {
  const router = express.Router();

  router.use(createMariaDbProviderInvitationRouter(database, options));
  router.use(createMariaDbProviderPortalRouter(database, options));

  return router;
}

module.exports = createMariaDbProviderAreaRouter;
