'use strict';

module.exports = function assertTenantCutoverReady(env = process.env) {
  const enabled = env.ENABLE_MULTI_TENANT === 'true';
  const explicitlyApproved = env.MULTI_TENANT_CUTOVER_APPROVED === 'true';
  if (enabled && !explicitlyApproved) {
    throw new Error(
      'ENABLE_MULTI_TENANT is blocked: set MULTI_TENANT_CUTOVER_APPROVED only after the isolated database preflight and route-cutover review are approved.'
    );
  }
  if (!enabled && explicitlyApproved) {
    throw new Error('MULTI_TENANT_CUTOVER_APPROVED cannot be set while ENABLE_MULTI_TENANT is false.');
  }
};
