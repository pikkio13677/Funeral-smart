'use strict';

module.exports = function createLegacyAdminReadGuard(tenantFeaturesEnabled) {
  if (typeof tenantFeaturesEnabled !== 'boolean') {
    throw new TypeError('tenantFeaturesEnabled must be a boolean.');
  }
  return function legacyAdminReadGuard(_req, res, next) {
    if (tenantFeaturesEnabled) {
      return res.status(410).json({
        error: 'Consultazione globale disabilitata: usa le API aziendali autorizzate.'
      });
    }
    return next();
  };
};
