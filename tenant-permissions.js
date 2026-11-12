'use strict';

// Tenant roles are scoped to one verified membership.
// platform_admin is deliberately NOT a tenant role.
const PERMISSIONS = Object.freeze({
  admin: Object.freeze({
    dashboard: ['read'],
    customers: ['read', 'create', 'update'],
    cases: ['read', 'create', 'update'],
    staff: ['read', 'create', 'update'],
    vehicles: ['read', 'create', 'update'],
    inventory: ['read', 'create', 'update'],
    tasks: ['read', 'create', 'update'],
    invoices: ['read', 'create', 'issue', 'pay'],
    audit: ['read'],
    company: ['read', 'update'],
    members: ['read', 'invite', 'update']
  }),
  manager: Object.freeze({
    dashboard: ['read'],
    customers: ['read', 'create', 'update'],
    cases: ['read', 'create', 'update'],
    staff: ['read'],
    vehicles: ['read'],
    inventory: ['read', 'create', 'update'],
    tasks: ['read', 'create', 'update'],
    invoices: ['read'],
    audit: ['read']
  }),
  operator: Object.freeze({
    dashboard: ['read'],
    customers: ['read', 'create'],
    cases: ['read', 'create', 'update'],
    tasks: ['read', 'create', 'update']
  }),
  warehouse: Object.freeze({
    dashboard: ['read'],
    inventory: ['read', 'create', 'update'],
    cases: ['read'],
    tasks: ['read']
  }),
  accounting: Object.freeze({
    dashboard: ['read'],
    customers: ['read'],
    cases: ['read'],
    invoices: ['read', 'create', 'issue', 'pay'],
    audit: ['read']
  })
});

function canTenant(role, resource, action) {
  if (typeof role !== 'string' || typeof resource !== 'string' || typeof action !== 'string') return false;
  const rolePermissions = PERMISSIONS[role];
  return Boolean(rolePermissions && rolePermissions[resource]?.includes(action));
}

function authorizeTenant(resource, action) {
  if (typeof resource !== 'string' || !resource || typeof action !== 'string' || !action) {
    throw new TypeError('A tenant resource and action are required.');
  }
  return function tenantAuthorization(req, res, next) {
    if (!req.tenant || !req.tenant.companyId || !req.tenant.membershipId) {
      return res.status(403).json({ error: 'Contesto aziendale richiesto.' });
    }
    if (!canTenant(req.tenant.role, resource, action)) {
      return res.status(403).json({ error: 'Operazione non consentita per il tuo ruolo aziendale.' });
    }
    return next();
  };
}

module.exports = { PERMISSIONS, canTenant, authorizeTenant };
