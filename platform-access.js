'use strict';

// Platform privileges are independent from app_users.role and tenant membership roles.
// This middleware is intentionally not mounted until platform routes are reviewed.
module.exports = function createPlatformAccess(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }

  function requirePlatformRole(...allowedRoles) {
    const roles = [...new Set(allowedRoles)];
    if (!roles.length || roles.some(role => !['owner', 'support'].includes(role))) {
      throw new TypeError('At least one valid platform role is required.');
    }

    return async function platformAuthorization(req, res, next) {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Autenticazione richiesta.' });
      }

      try {
        const result = await pool.query(
          `SELECT pa.role
           FROM platform_access pa
           JOIN app_users u ON u.id = pa.user_id
           WHERE pa.user_id = $1
             AND pa.status = 'active'
             AND u.active = TRUE
             AND pa.role = ANY($2::varchar[])`,
          [req.user.id, roles]
        );

        if (!result.rowCount) {
          return res.status(403).json({ error: 'Permessi di piattaforma insufficienti.' });
        }

        // Never infer platform privileges from req.user.role (including 'admin').
        req.platformAccess = Object.freeze({ role: result.rows[0].role });
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { requirePlatformRole };
};
