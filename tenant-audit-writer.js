'use strict';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function routeResource(pathname) {
  const parts = String(pathname || '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'company' && parts[1] === 'invitations') return 'company_invitations';
  if (parts[0] === 'company' && parts[1] === 'members') return 'company_memberships';
  if (parts[0] === 'company' && parts[1] === 'profile') return 'companies';
  if (parts[0] === 'inventory' && parts[2] === 'movements') return 'stock_movements';
  if (parts[0] === 'invoices' && parts[2] === 'payments') return 'payments';
  return (parts[0] || 'tenant').replace(/[^a-z0-9_]/gi, '').slice(0, 80) || 'tenant';
}

function routeResourceId(req) {
  const params = req.params || {};
  const direct = params.id || params.membershipId || params.invitationId;
  if (typeof direct === 'string' && direct.length <= 80) return direct;
  const parts = String(req.path || '').split('?')[0].split('/').filter(Boolean);
  const candidate = parts.find(part => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) || /^\d{1,18}$/.test(part));
  return candidate || null;
}

module.exports = function createTenantAuditWriter(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }

  return function tenantAuditWriter(req, res, next) {
    if (!MUTATING_METHODS.has(String(req.method || '').toUpperCase())
      || !req.user?.id
      || !req.tenant?.companyId
      || !req.tenant?.membershipId) {
      return next();
    }

    const method = String(req.method).toUpperCase();
    const resource = routeResource(req.path);
    const resourceId = routeResourceId(req);
    const verb = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
    const values = [
      req.user.id,
      req.user.username || null,
      'tenant.' + resource + '.' + verb,
      resource,
      resourceId,
      req.tenant.companyId,
      req.tenant.membershipId,
      req.ip || null
    ];

    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      pool.query(
        `INSERT INTO audit_log
          (user_id, username, action, resource, resource_id, company_id, membership_id, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        values
      ).catch(() => {
        // Audit failure must not expose request data or alter an already-sent response.
        console.error('Impossibile registrare un evento aziendale nel registro attività.');
      });
    });

    return next();
  };
};
