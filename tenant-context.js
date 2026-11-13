'use strict';

// Isolated tenant-context middleware. Not mounted by server.js yet.
// Requires migrations 005 and 006 on a TEST database before integration.
module.exports = function createTenantContext(pool, tokenHash, cookieName = 'fs_session') {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }
  if (typeof tokenHash !== 'function') {
    throw new TypeError('A token hashing function is required.');
  }

  return async function tenantContext(req, res, next) {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Autenticazione richiesta.' });
      }

      const token = req.cookies?.[cookieName];
      if (typeof token !== 'string' || token.length < 32) {
        return res.status(401).json({ error: 'Sessione non valida.' });
      }

      const result = await pool.query(
        `SELECT
           m.id AS "membershipId",
           m.company_id AS "companyId",
           m.role AS "role"
         FROM app_sessions s
         JOIN app_users u ON u.id = s.user_id
         JOIN company_memberships m
           ON m.id = s.active_membership_id
          AND m.user_id = s.user_id
         JOIN companies c ON c.id = m.company_id
         WHERE s.token_hash = $1
           AND s.user_id = $2
           AND s.expires_at > NOW()
           AND u.active = TRUE
           AND m.status = 'active'
           AND c.status = 'active'
         LIMIT 1`,
        [tokenHash(token), req.user.id]
      );

      if (!result.rowCount) {
        return res.status(403).json({
          error: 'Seleziona un’azienda attiva per accedere ai reparti.'
        });
      }

      // Tenant identity and role are sourced exclusively from verified DB rows.
      req.tenant = Object.freeze({
        membershipId: result.rows[0].membershipId,
        companyId: result.rows[0].companyId,
        role: result.rows[0].role
      });

      return next();
    } catch (error) {
      return next(error);
    }
  };
};
