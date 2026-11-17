'use strict';

module.exports = function assertTenantCutoverReady(env = process.env) {
  if (env.ENABLE_MULTI_TENANT === 'true') {
    throw new Error(
      'ENABLE_MULTI_TENANT cannot be enabled: the tenant API and legacy-route cutover are not mounted in this build.'
    );
  }
};
